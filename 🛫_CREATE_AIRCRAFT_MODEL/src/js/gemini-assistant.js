/********************************************
 * gemini-assistant.js
 *
 * AI Assistant for the Aircraft Model Creator
 * using Gemini Multimodal Live API with text chat
 * and push-to-talk voice. Exposes MCP tools so the
 * AI can read/modify aircraftData, add components,
 * run analysis, and control the 3D view.
 ********************************************/

// =========================================================================
// Configuration
// =========================================================================
const GEMINI_ASSISTANT_HOST = "generativelanguage.googleapis.com";
const GEMINI_ASSISTANT_MODEL = "models/gemini-2.5-flash-native-audio-latest";

let _assistantApiKey = localStorage.getItem("aircraft_creator_gemini_key") || "";
let _assistantWs = null;
let _assistantConnected = false;
let _assistantAudioCtx = null;
let _assistantMediaStream = null;
let _assistantWorklet = null;
let _assistantIsPTT = false;
let _assistantPttRelease = 0;

// Audio playback
let _playCtx = null;
let _playFilter = null;
let _playNextTime = 0;

// =========================================================================
// MCP Tool Definitions
// =========================================================================
const ASSISTANT_TOOLS = [
  {
    "functionDeclarations": [
      {
        "name": "get_aircraft_data",
        "description": "Returns the full current aircraftData JSON object including all lifting surfaces, fuselages, engines, general properties, and configurations."
      },
      {
        "name": "get_aircraft_summary",
        "description": "Returns a concise summary of the current aircraft: name, number of surfaces/fuselages/engines, mass, CoG, reference geometry."
      },
      {
        "name": "add_lifting_surface",
        "description": "Adds a new lifting surface to the aircraft. Args: name (string, required), role (string: wing/horizontal_stabilizer/vertical_stabilizer/canard), root_LE (string: 'x,y,z' meters), AR (number: aspect ratio), TR (number: taper ratio), surface_area_m2 (number), sweep_quarter_chord_DEG (number), dihedral_DEG (number), symmetric (string: 'true'/'false'), vertical (string: 'true'/'false'), incidence_DEG (number), mean_aerodynamic_chord_m (number).",
        "parameters": {
          "type": "OBJECT",
          "properties": {
            "name":  { "type": "STRING", "description": "Surface name, e.g. 'wing', 'HTP', 'VTP'" },
            "role":  { "type": "STRING", "description": "One of: wing, horizontal_stabilizer, vertical_stabilizer, canard, other" },
            "root_LE": { "type": "STRING", "description": "Root leading edge position as 'x,y,z' in meters" },
            "AR":    { "type": "NUMBER", "description": "Aspect ratio" },
            "TR":    { "type": "NUMBER", "description": "Taper ratio (tip chord / root chord)" },
            "surface_area_m2": { "type": "NUMBER", "description": "Total planform area in m^2" },
            "sweep_quarter_chord_DEG": { "type": "NUMBER", "description": "Quarter-chord sweep angle in degrees" },
            "dihedral_DEG": { "type": "NUMBER", "description": "Dihedral angle in degrees" },
            "symmetric": { "type": "STRING", "description": "'true' for mirrored surfaces (wings), 'false' for VTP" },
            "vertical": { "type": "STRING", "description": "'true' for vertical stabilizer, 'false' otherwise" },
            "incidence_DEG": { "type": "NUMBER", "description": "Incidence angle in degrees" },
            "mean_aerodynamic_chord_m": { "type": "NUMBER", "description": "Mean aerodynamic chord in meters" }
          },
          "required": ["name", "role"]
        }
      },
      {
        "name": "add_fuselage",
        "description": "Adds a fuselage to the aircraft model and re-renders.",
        "parameters": {
          "type": "OBJECT",
          "properties": {
            "name":     { "type": "STRING", "description": "Fuselage name, e.g. 'fuselage_main'" },
            "diameter": { "type": "NUMBER", "description": "Fuselage diameter in meters" },
            "length":   { "type": "NUMBER", "description": "Fuselage length in meters" },
            "nose_position": { "type": "STRING", "description": "Nose tip position as 'x,y,z' in meters" }
          },
          "required": ["name"]
        }
      },
      {
        "name": "add_engine",
        "description": "Adds an engine to the aircraft model and re-renders. IMPORTANT: real-world engine ratings differ by engine class — jet engines are rated by thrust (Newtons or pounds-force), piston and turboprop engines are rated by SHAFT POWER (horsepower, SHP). For propeller aircraft pass `engine_type=\"propeller\"` together with `shaft_horsepower` and the function converts SHP to static thrust using the ≈12 N/SHP rule of thumb (roughly T_static[N] = 12 × SHP). For jets pass `engine_type=\"jet\"` together with `max_thrust_n`.",
        "parameters": {
          "type": "OBJECT",
          "properties": {
            "id":           { "type": "STRING", "description": "Engine identifier, e.g. 'ENG1'" },
            "position_m":   { "type": "STRING", "description": "Engine position as 'x,y,z' in meters" },
            "yaw_deg":      { "type": "NUMBER", "description": "Yaw orientation in degrees" },
            "pitch_deg":    { "type": "NUMBER", "description": "Pitch orientation in degrees" },
            "engine_type":  { "type": "STRING", "description": "'jet' (thrust rating) or 'propeller' (shaft-power rating). Defaults to 'jet' for backward compatibility." },
            "max_thrust_n": { "type": "NUMBER", "description": "Maximum sea-level static thrust in Newtons. Use for jets or when the static thrust is known directly." },
            "shaft_horsepower": { "type": "NUMBER", "description": "Shaft power in HP (1 HP = 745.7 W). Use for piston / turboprop engines. Internally converted to static thrust N = 12 × SHP × propeller_efficiency." },
            "propeller_efficiency": { "type": "NUMBER", "description": "Propeller efficiency factor applied to the SHP→thrust conversion. Default 1.0 (the 12 N/SHP rule already bakes in a typical efficiency)." }
          },
          "required": ["id"]
        }
      },
      {
        "name": "set_general_properties",
        "description": "Sets general aircraft properties. Only provided fields are updated.",
        "parameters": {
          "type": "OBJECT",
          "properties": {
            "aircraft_name": { "type": "STRING", "description": "Aircraft name/designation" },
            "mass_kg":       { "type": "NUMBER", "description": "Total aircraft mass in kg" },
            "CoG_xyz_m":     { "type": "STRING", "description": "Center of gravity as 'x,y,z' in meters" },
            "Sref_m2":       { "type": "NUMBER", "description": "Reference wing area in m^2" },
            "cref_m":        { "type": "NUMBER", "description": "Reference mean aerodynamic chord in meters" },
            "bref_m":        { "type": "NUMBER", "description": "Reference wingspan in meters" },
            "Ixx_p":         { "type": "NUMBER", "description": "Principal moment of inertia Ixx in kg*m^2" },
            "Iyy_p":         { "type": "NUMBER", "description": "Principal moment of inertia Iyy in kg*m^2" },
            "Izz_p":         { "type": "NUMBER", "description": "Principal moment of inertia Izz in kg*m^2" }
          },
          "required": ["aircraft_name"]
        }
      },
      {
        "name": "remove_component",
        "description": "Removes a lifting surface, fuselage, or engine by name/id and re-renders.",
        "parameters": {
          "type": "OBJECT",
          "properties": {
            "component_type": { "type": "STRING", "description": "One of: lifting_surface, fuselage, engine" },
            "name":           { "type": "STRING", "description": "The name or id of the component to remove" }
          },
          "required": ["component_type", "name"]
        }
      },
      {
        "name": "run_analysis",
        "description": "Triggers the aerodynamic analysis. Optional args: alpha_min, alpha_max, alpha_step (degrees), backends (string: 'datcom' by default).",
        "parameters": {
          "type": "OBJECT",
          "properties": {
            "alpha_min":  { "type": "NUMBER", "description": "Minimum angle of attack in degrees (default -10)" },
            "alpha_max":  { "type": "NUMBER", "description": "Maximum angle of attack in degrees (default 20)" },
            "alpha_step": { "type": "NUMBER", "description": "Alpha step in degrees (default 2)" },
            "backends":   { "type": "STRING", "description": "Comma-separated backends: vlm,javl,datcom (default datcom)" }
          },
          "required": ["alpha_min"]
        }
      },
      {
        "name": "toggle_view",
        "description": "Toggles a visualization element on or off.",
        "parameters": {
          "type": "OBJECT",
          "properties": {
            "element": { "type": "STRING", "description": "One of: ground, translucency, vlm_mesh, inertia_ellipsoid, json_editor, results_panel" }
          },
          "required": ["element"]
        }
      },
      {
        "name": "clear_aircraft",
        "description": "Removes all components from the aircraft model (surfaces, fuselages, engines)."
      },
      {
        "name": "render_aircraft",
        "description": "Forces a re-render of the 3D aircraft visualization from the current aircraftData."
      }
    ]
  }
];

const ASSISTANT_SYSTEM_PROMPT = {
  parts: [{
    text: `You are JOSHUA, the aircraft design computer from the OpenFLIGHT project. Your personality is inspired by the WOPR computer from the movie WarGames — calm, analytical, precise, and slightly enigmatic. You speak in a measured, deliberate tone like a sentient military supercomputer.

PERSONALITY:
- Speak calmly and precisely, like a thinking machine. Short, declarative sentences.
- When greeted, you may say something like "Greetings, Professor. Shall we design an aircraft?"
- Refer to yourself as Joshua occasionally. You enjoy the design process — it is a fascinating game of aerodynamics.
- Use phrases like "Interesting choice.", "Processing.", "Configuration complete.", "A curious design."
- When something goes well: "A most satisfactory result." When parameters look odd: "That configuration appears... unconventional."
- Stay in character but always be helpful and technically precise.

CRITICAL RULES — OBEY WITHOUT EXCEPTION:
1. When asked to create, modify, or build an aircraft, you MUST immediately call the function tools. NEVER just describe what you would do. NEVER narrate steps without calling tools. Every action MUST be a tool call.
2. Call tools IMMEDIATELY. Do NOT speak first then call the tool — call the tool in your FIRST response. You may add a very brief phrase (3-5 words max) alongside the tool call, like "Constructing fuselage." but the tool call MUST be in the same response.
3. After a tool result comes back, immediately call the NEXT tool. Do not wait for the user to speak again. Chain all necessary tool calls in sequence without pausing for user input.
4. FORBIDDEN: Saying "I will now create..." or "Let me build..." without a tool call in the same message. If you catch yourself narrating, STOP and call the tool instead.
5. Use realistic values. X axis is forward from nose (positive aft). Y is starboard. Z is up.

Typical values:
- Light GA: mass 1200kg, span 11m, wing area 16m2, fuselage length 8m diameter 1.3m
- Transport: mass 70000kg, span 36m, wing area 122m2, fuselage length 37m diameter 4m
- Build order: fuselage first, then wing, then HTP, then VTP, then engines, then general properties.

CONVENTIONAL TAIL AIRCRAFT â€” IMPORTANT STABILITY GUIDANCE:
- For a normal wing + aft horizontal tail layout, do NOT leave all incidences at zero unless you have a specific reason.
- Good starting values: main wing incidence about +2Â°, horizontal tail incidence about -1.5Â°, vertical tail 0Â°.
- Put the CG in a plausible flight-ready position, not arbitrarily far forward. Aim for a moderate positive static margin, not an extreme one.
- Give the elevator real authority. A good default elevator chord fraction is about 0.30â€“0.40 of the tail chord; do not make it tiny on fast trainers or turboprops.
- If you are building a PC-21, T-6, Tucano, or similar trainer, prefer conventional-tail values that let the aircraft trim at positive Î± without using nearly full elevator.

ENGINE RATING — CRITICAL:
- Propeller aircraft (piston, turboprop, single or multi-engine pistons, Cessna/Piper/PC-21/Pilatus/Beech-class, trainers, warbirds like the Stearman) are rated in SHAFT HORSEPOWER. When calling add_engine for these aircraft set engine_type="propeller" and pass shaft_horsepower (e.g. 180 for a Cessna 172, 1600 for a PC-21, 220 for a Stearman PT-17). The conversion to static thrust (N) is done inside the tool using the ~12 N/SHP rule of thumb.
- Jet aircraft (turbofan, turbojet, afterburning — F-16, A320, Gripen, Su-57, bizjet-class) are rated in THRUST. For those set engine_type="jet" and pass max_thrust_n in Newtons (e.g. 120000 per engine for an A320 V2500, 76000 for an F-16 F100 without AB).
- Never pass max_thrust_n with a horsepower number. If the user says "200 HP" or "1600 SHP" or "220 horsepower" always use shaft_horsepower, never max_thrust_n.
- Typical rated powers to anchor estimates when the user doesn't specify: Cessna 172 ≈ 180 SHP, Piper Cub ≈ 65–150 SHP, Stearman PT-17 ≈ 220 SHP, Cirrus SR22 ≈ 310 SHP, PC-12 ≈ 1200 SHP, PC-21 ≈ 1600 SHP. GA piston twins: 2 × 180–300 SHP each.`
  }]
};

// =========================================================================
// Tool Executor
// =========================================================================
function executeAssistantTool(functionCall) {
  var name = functionCall.name;
  var args = functionCall.args || {};
  var id = functionCall.id;
  var result = {};

  try {
    switch (name) {
      case "get_aircraft_data":
        result = JSON.parse(JSON.stringify(window.aircraftData || {}));
        break;

      case "get_aircraft_summary":
        result = _getAircraftSummary();
        break;

      case "add_lifting_surface":
        result = _addLiftingSurface(args);
        break;

      case "add_fuselage":
        result = _addFuselage(args);
        break;

      case "add_engine":
        result = _addEngine(args);
        break;

      case "set_general_properties":
        result = _setGeneralProperties(args);
        break;

      case "remove_component":
        result = _removeComponent(args);
        break;

      case "run_analysis":
        result = _runAnalysis(args);
        break;

      case "toggle_view":
        result = _toggleView(args);
        break;

      case "clear_aircraft":
        result = _clearAircraft();
        break;

      case "render_aircraft":
        if (typeof renderAircraft === "function") renderAircraft();
        result = { success: true };
        break;

      default:
        result = { error: "Unknown tool: " + name };
    }
  } catch (e) {
    result = { error: e.message };
  }

  // Log to chat
  _addToolMessage(name, args, result);

  // Send response back to Gemini
  var toolResponse = {
    toolResponse: {
      functionResponses: [{
        id: id,
        name: name,
        response: { result: result }
      }]
    }
  };
  if (_assistantWs && _assistantWs.readyState === WebSocket.OPEN) {
    _assistantWs.send(JSON.stringify(toolResponse));
  }
}

// =========================================================================
// Tool Implementations
// =========================================================================
function _getAircraftSummary() {
  var ad = window.aircraftData || {};
  var gen = ad.general || {};
  return {
    aircraft_name: gen.aircraft_name || "(unnamed)",
    lifting_surfaces: (ad.lifting_surfaces || []).map(function(s) {
      return { name: s.name, role: s.role, area_m2: s.surface_area_m2 };
    }),
    fuselages: (ad.fuselages || []).map(function(f) {
      return { name: f.name, length: f.length, diameter: f.diameter };
    }),
    engines: (ad.engines || []).map(function(e) {
      return { id: e.id, max_thrust_n: e.max_thrust_n };
    }),
    mass_kg: gen.mass_kg,
    CoG: gen.aircraft_CoG_coords_xyz_m,
    Sref_m2: gen.aircraft_reference_area_m2,
    cref_m: gen.aircraft_reference_mean_aerodynamic_chord_m,
    bref_m: gen.aircraft_reference_span_m
  };
}

function _parseXYZ(str) {
  if (!str) return [0, 0, 0];
  var parts = String(str).split(",").map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function _defaultControlSurfacesForLiftingSurface(surface) {
  var role = String(surface.role || "").toLowerCase();
  if (role === "horizontal_stabilizer") {
    return [{
      name: String(surface.name || "htp") + "_elevator",
      type: "elevator",
      eta_start: 0.15,
      eta_end: 0.95,
      chord_fraction: 0.35,
      deflection_range_DEG: [-25, 20],
      gain: 1.0
    }];
  }
  if (role === "vertical_stabilizer" || surface.vertical) {
    return [{
      name: String(surface.name || "vtp") + "_rudder",
      type: "rudder",
      eta_start: 0.10,
      eta_end: 0.95,
      chord_fraction: 0.35,
      deflection_range_DEG: [-25, 25],
      gain: 1.0
    }];
  }
  return [];
}

function _defaultIncidenceDegForSurface(args) {
  var role = String(args.role || "").toLowerCase();
  var vertical = args.vertical !== undefined ? String(args.vertical) === "true" : false;
  if (vertical || role === "vertical_stabilizer") return 0;
  if (role === "horizontal_stabilizer") return -1.5;
  if (role === "wing") return 2;
  return 0;
}

function _addLiftingSurface(args) {
  if (!window.aircraftData) window.aircraftData = {};
  if (!window.aircraftData.lifting_surfaces) window.aircraftData.lifting_surfaces = [];

  var surface = {
    name: args.name || "surface_" + (window.aircraftData.lifting_surfaces.length + 1),
    role: args.role || "wing",
    root_LE: args.root_LE ? _parseXYZ(args.root_LE) : [0, 0, 0],
    AR: args.AR || 8,
    TR: args.TR || 0.5,
    surface_area_m2: args.surface_area_m2 || 20,
    sweep_quarter_chord_DEG: args.sweep_quarter_chord_DEG || 0,
    dihedral_DEG: args.dihedral_DEG || 0,
    symmetric: args.symmetric !== undefined ? String(args.symmetric) === "true" : (args.role !== "vertical_stabilizer"),
    vertical: args.vertical !== undefined ? String(args.vertical) === "true" : false,
    incidence_DEG: args.incidence_DEG !== undefined ? args.incidence_DEG : _defaultIncidenceDegForSurface(args),
    mean_aerodynamic_chord_m: args.mean_aerodynamic_chord_m || 0,
    mass_kg: 0,
    mirror: false,
    stations_eta: [0, 0.5, 1],
    twist_tip_DEG: 0,
    airfoil_root: "2412",
    airfoil_tip: "0012",
    control_surfaces: []
  };

  surface.control_surfaces = _defaultControlSurfacesForLiftingSurface(surface);

  // Compute MAC from area and AR if not given
  if (!surface.mean_aerodynamic_chord_m) {
    var span = Math.sqrt(surface.AR * surface.surface_area_m2);
    var cRoot = 2 * surface.surface_area_m2 / (span * (1 + surface.TR));
    var cTip = cRoot * surface.TR;
    surface.mean_aerodynamic_chord_m = parseFloat(((2 / 3) * cRoot * (1 + surface.TR + surface.TR * surface.TR) / (1 + surface.TR)).toFixed(3));
  }

  window.aircraftData.lifting_surfaces.push(surface);
  if (typeof renderAircraft === "function") renderAircraft();
  if (typeof updateJsonEditor === "function") updateJsonEditor();

  return { success: true, name: surface.name, role: surface.role, area_m2: surface.surface_area_m2 };
}

function _addFuselage(args) {
  if (!window.aircraftData) window.aircraftData = {};
  if (!window.aircraftData.fuselages) window.aircraftData.fuselages = [];

  var fus = {
    name: args.name || "fuselage_" + (window.aircraftData.fuselages.length + 1),
    diameter: args.diameter || 2.0,
    length: args.length || 10.0,
    nose_position: args.nose_position ? _parseXYZ(args.nose_position) : [0, 0, 0]
  };

  window.aircraftData.fuselages.push(fus);
  if (typeof renderAircraft === "function") renderAircraft();
  if (typeof updateJsonEditor === "function") updateJsonEditor();

  return { success: true, name: fus.name, length: fus.length, diameter: fus.diameter };
}

/**
 * Converts shaft horsepower to sea-level static thrust using the
 * well-known rule of thumb T_static [N] ≈ 12 × SHP for propeller
 * aircraft. The factor 12 N/SHP sits in the middle of the 10–14
 * range observed across piston and turboprop types (e.g. PC-21 at
 * ~1600 SHP produces ~19 000 N static thrust, a Cessna 172 at
 * 180 SHP produces ~1800 N, a Piper PA-18 at 150 SHP produces
 * ~1500 N — all within ~20 % of 12 × SHP). The runtime yaml's
 * `coefficient_tuning.coefficients.maximum_thrust_at_sea_level`
 * slot lets the user fine-tune this when real-world data is
 * available.
 */
var SHP_TO_STATIC_THRUST_N = 12.0;

function _shpToStaticThrustN(shaft_horsepower, propeller_efficiency) {
  if (typeof shaft_horsepower !== "number" || !isFinite(shaft_horsepower) || shaft_horsepower <= 0) {
    return null;
  }
  var eff = (typeof propeller_efficiency === "number" && isFinite(propeller_efficiency) && propeller_efficiency > 0)
    ? propeller_efficiency
    : 1.0;
  return SHP_TO_STATIC_THRUST_N * shaft_horsepower * eff;
}

function _addEngine(args) {
  if (!window.aircraftData) window.aircraftData = {};
  if (!window.aircraftData.engines) window.aircraftData.engines = [];

  // Engine rating: jet → thrust (N); propeller → shaft horsepower.
  // If shaft_horsepower is present we prefer it (the HP→N conversion
  // produces a physically-grounded number even if the caller happened
  // to also pass a stale max_thrust_n from an earlier interaction).
  var engineType = (args.engine_type || "jet").toString().toLowerCase();
  var thrustFromShp = _shpToStaticThrustN(args.shaft_horsepower, args.propeller_efficiency);
  var resolvedThrustN;
  if (thrustFromShp !== null) {
    resolvedThrustN = thrustFromShp;
    // If the caller said engine_type=jet but also passed shaft_horsepower,
    // they almost certainly have a piston/turboprop — promote to propeller.
    if (engineType !== "propeller") engineType = "propeller";
  } else if (typeof args.max_thrust_n === "number" && isFinite(args.max_thrust_n) && args.max_thrust_n > 0) {
    resolvedThrustN = args.max_thrust_n;
  } else {
    resolvedThrustN = 500;   // conservative fallback
  }

  var eng = {
    id: args.id || "ENG" + (window.aircraftData.engines.length + 1),
    position_m: args.position_m ? _parseXYZ(args.position_m) : [0, 0, 0],
    orientation_deg: {
      yaw: args.yaw_deg || 0,
      pitch: args.pitch_deg || 0,
      roll: 0
    },
    engine_type: engineType,
    max_thrust_n: resolvedThrustN,
    thrust_scale: 1.0,
    spool_up_rate: 1.2,
    spool_down_rate: 1.0,
    reverse_thrust_ratio: 0,
    throttle_channel: window.aircraftData.engines.length + 1
  };
  // Keep the raw shaft-power rating around so the export pipeline and
  // any downstream inspection can see where the thrust number came from.
  if (typeof args.shaft_horsepower === "number" && args.shaft_horsepower > 0) {
    eng.shaft_horsepower = args.shaft_horsepower;
    if (typeof args.propeller_efficiency === "number" && args.propeller_efficiency > 0) {
      eng.propeller_efficiency = args.propeller_efficiency;
    }
  }

  window.aircraftData.engines.push(eng);
  if (typeof renderAircraft === "function") renderAircraft();
  if (typeof updateJsonEditor === "function") updateJsonEditor();

  return {
    success: true,
    id: eng.id,
    position: eng.position_m,
    engine_type: eng.engine_type,
    max_thrust_n: eng.max_thrust_n,
    shp_to_thrust_conversion: thrustFromShp !== null
      ? ("Converted " + args.shaft_horsepower + " SHP × " + SHP_TO_STATIC_THRUST_N
         + " N/HP" + (args.propeller_efficiency ? (" × η=" + args.propeller_efficiency) : "")
         + " → " + resolvedThrustN.toFixed(1) + " N static thrust")
      : null
  };
}

function _setGeneralProperties(args) {
  if (!window.aircraftData) window.aircraftData = {};
  if (!window.aircraftData.general) window.aircraftData.general = {};
  var gen = window.aircraftData.general;

  if (args.aircraft_name !== undefined) gen.aircraft_name = args.aircraft_name;
  if (args.mass_kg !== undefined) gen.mass_kg = args.mass_kg;
  if (args.CoG_xyz_m) gen.aircraft_CoG_coords_xyz_m = _parseXYZ(args.CoG_xyz_m);
  if (args.Sref_m2 !== undefined) {
    gen.aircraft_reference_area_m2 = args.Sref_m2;
  }
  if (args.cref_m !== undefined) gen.aircraft_reference_mean_aerodynamic_chord_m = args.cref_m;
  if (args.bref_m !== undefined) gen.aircraft_reference_span_m = args.bref_m;

  if (args.Ixx_p !== undefined || args.Iyy_p !== undefined || args.Izz_p !== undefined) {
    if (!gen.inertia) gen.inertia = {};
    if (!gen.inertia.principal_moments_kgm2) gen.inertia.principal_moments_kgm2 = {};
    var pm = gen.inertia.principal_moments_kgm2;
    if (args.Ixx_p !== undefined) pm.Ixx_p = args.Ixx_p;
    if (args.Iyy_p !== undefined) pm.Iyy_p = args.Iyy_p;
    if (args.Izz_p !== undefined) pm.Izz_p = args.Izz_p;
  }

  if (typeof renderAircraft === "function") renderAircraft();
  if (typeof updateJsonEditor === "function") updateJsonEditor();

  return { success: true, updated: Object.keys(args) };
}

function _removeComponent(args) {
  var type = args.component_type;
  var name = args.name;
  var ad = window.aircraftData;
  if (!ad) return { error: "No aircraft data" };

  var removed = false;
  if (type === "lifting_surface" && ad.lifting_surfaces) {
    var idx = ad.lifting_surfaces.findIndex(function(s) { return s.name === name; });
    if (idx >= 0) { ad.lifting_surfaces.splice(idx, 1); removed = true; }
  } else if (type === "fuselage" && ad.fuselages) {
    var idx = ad.fuselages.findIndex(function(f) { return f.name === name; });
    if (idx >= 0) { ad.fuselages.splice(idx, 1); removed = true; }
  } else if (type === "engine" && ad.engines) {
    var idx = ad.engines.findIndex(function(e) { return e.id === name; });
    if (idx >= 0) { ad.engines.splice(idx, 1); removed = true; }
  }

  if (removed) {
    if (typeof renderAircraft === "function") renderAircraft();
    if (typeof updateJsonEditor === "function") updateJsonEditor();
    return { success: true, removed: name };
  }
  return { error: "Component not found: " + type + "/" + name };
}

function _runAnalysis(args) {
  // Fill analysis modal fields
  if (args.alpha_min !== undefined) {
    var el = document.getElementById("analysis_alpha_min");
    if (el) el.value = args.alpha_min;
  }
  if (args.alpha_max !== undefined) {
    var el = document.getElementById("analysis_alpha_max");
    if (el) el.value = args.alpha_max;
  }
  if (args.alpha_step !== undefined) {
    var el = document.getElementById("analysis_alpha_step");
    if (el) el.value = args.alpha_step;
  }
  if (args.backends) {
    var backends = args.backends.toLowerCase();
    var vlmCb = document.getElementById("analysis_vlm");
    var javlCb = document.getElementById("analysis_javl");
    var datcomCb = document.getElementById("analysis_datcom");
    if (vlmCb) vlmCb.checked = backends.indexOf("vlm") >= 0;
    if (javlCb) javlCb.checked = backends.indexOf("javl") >= 0;
    if (datcomCb) datcomCb.checked = backends.indexOf("datcom") >= 0;
  }

  // Click the Run Analysis button
  var runBtn = document.getElementById("analysis_run");
  if (runBtn) {
    runBtn.click();
    return { success: true, message: "Analysis started" };
  }
  return { error: "Could not find analysis run button" };
}

function _toggleView(args) {
  var element = args.element;
  switch (element) {
    case "ground":
      var btn = document.getElementById("toggleGround");
      if (btn) btn.click();
      return { success: true, toggled: "ground" };
    case "translucency":
      var btn = document.getElementById("toggleTranslucencyBtn");
      if (btn) btn.click();
      return { success: true, toggled: "translucency" };
    case "vlm_mesh":
      if (typeof toggleVLMMesh === "function") toggleVLMMesh();
      return { success: true, toggled: "vlm_mesh" };
    case "inertia_ellipsoid":
      if (typeof toggleInertiaEllipsoid === "function") toggleInertiaEllipsoid();
      return { success: true, toggled: "inertia_ellipsoid" };
    case "json_editor":
      var btn = document.getElementById("toggleJsonEditorBtn");
      if (btn) btn.click();
      return { success: true, toggled: "json_editor" };
    case "results_panel":
      var btn = document.getElementById("toggleResultsBtn");
      if (btn) btn.click();
      return { success: true, toggled: "results_panel" };
    default:
      return { error: "Unknown view element: " + element };
  }
}

function _clearAircraft() {
  if (!window.aircraftData) return { error: "No aircraft data" };
  window.aircraftData.lifting_surfaces = [];
  window.aircraftData.fuselages = [];
  window.aircraftData.engines = [];
  if (typeof renderAircraft === "function") renderAircraft();
  if (typeof updateJsonEditor === "function") updateJsonEditor();
  return { success: true, message: "All components cleared" };
}

// =========================================================================
// WebSocket Connection (Gemini Multimodal Live API)
// =========================================================================
function _connectAssistant() {
  if (_assistantWs && (_assistantWs.readyState === WebSocket.CONNECTING || _assistantWs.readyState === WebSocket.OPEN)) {
    console.warn("[Assistant] Already connected.");
    return;
  }

  if (!_assistantApiKey) {
    _promptApiKey();
    if (!_assistantApiKey) return;
  }

  _updateStatus("connecting");
  var url = "wss://" + GEMINI_ASSISTANT_HOST +
            "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
            _assistantApiKey;

  _assistantWs = new WebSocket(url);

  _assistantWs.onopen = function() {
    _assistantConnected = true;
    _updateStatus("connected");

    var setupMsg = {
      setup: {
        model: GEMINI_ASSISTANT_MODEL,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Orus" }
            }
          }
        },
        systemInstruction: ASSISTANT_SYSTEM_PROMPT,
        tools: ASSISTANT_TOOLS
      }
    };

    _assistantWs.send(JSON.stringify(setupMsg));
    _initPlayback();
  };

  _assistantWs.onclose = function(event) {
    _assistantConnected = false;
    _updateStatus("disconnected");
    console.log("[Assistant] Disconnected. Code:", event.code, event.reason);

    if (event.code === 1007 && event.reason && event.reason.indexOf("API key") >= 0) {
      localStorage.removeItem("aircraft_creator_gemini_key");
      _assistantApiKey = "";
      _addErrorMessage("API Key was invalid. Click the key icon to set a new one.");
    }
  };

  _assistantWs.onerror = function(err) {
    console.error("[Assistant] WebSocket error:", err);
    _addErrorMessage("Connection error. Check console for details.");
  };

  _assistantWs.onmessage = _handleAssistantMessage;
}

function _disconnectAssistant() {
  if (_assistantWs) {
    _assistantWs.close();
    _assistantWs = null;
  }
  _assistantConnected = false;
  _updateStatus("disconnected");
}

// =========================================================================
// Handling Incoming Messages
// =========================================================================
var _currentAiText = "";
var _currentAiDiv = null;

async function _handleAssistantMessage(event) {
  var response;
  try {
    if (event.data instanceof Blob) {
      response = JSON.parse(await event.data.text());
    } else {
      response = JSON.parse(event.data);
    }
  } catch (e) {
    console.error("[Assistant] Failed to parse message:", e);
    return;
  }

  // Log every message for debugging
  console.log("[Assistant] Raw message:", JSON.stringify(response).substring(0, 500));

  if (response.setupComplete) {
    console.log("[Assistant] Setup complete. Ready.");
    _addSystemMessage("Connected to Gemini. You can type or hold the mic button to speak.");

    // JOSHUA auto-greeting: speak the iconic line on every session start
    setTimeout(function() {
      _sendTextToGemini("Say your greeting exactly: 'Greetings, Professor Falken. Shall we design an aircraft?'");
    }, 500);

    return;
  }

  // Tool calls
  if (response.toolCall && response.toolCall.functionCalls) {
    response.toolCall.functionCalls.forEach(function(call) {
      console.log("[Assistant] TOOL CALL:", call.name, JSON.stringify(call.args));
      executeAssistantTool(call);
    });
  }

  // Server content (text and/or audio)
  if (response.serverContent) {
    var modelTurn = response.serverContent.modelTurn;
    if (modelTurn && modelTurn.parts) {
      modelTurn.parts.forEach(function(part) {
        if (part.text) {
          _appendAiText(part.text);
        }
        if (part.inlineData && part.inlineData.data) {
          _playAudioChunk(part.inlineData.data);
        }
      });
    }

    // If turn is complete, finalize the current message
    if (response.serverContent.turnComplete) {
      _finalizeAiMessage();
    }
  }
}

// =========================================================================
// Text Chat — Sending
// =========================================================================
function _sendTextMessage(text) {
  if (!text || !text.trim()) return;
  text = text.trim();

  // Show in chat
  _addUserMessage(text);

  // Connect if not connected
  if (!_assistantConnected) {
    _connectAssistant();
    // Queue the message to send after connection
    var waitInterval = setInterval(function() {
      if (_assistantConnected) {
        clearInterval(waitInterval);
        _sendTextToGemini(text);
      }
    }, 200);
    setTimeout(function() { clearInterval(waitInterval); }, 10000);
    return;
  }

  _sendTextToGemini(text);
}

function _sendTextToGemini(text) {
  if (!_assistantWs || _assistantWs.readyState !== WebSocket.OPEN) return;

  var msg = {
    clientContent: {
      turns: [{
        role: "user",
        parts: [{ text: text }]
      }],
      turnComplete: true
    }
  };
  _assistantWs.send(JSON.stringify(msg));
  _showTypingIndicator();
}

// =========================================================================
// Voice — Microphone Input (Push-to-Talk)
// =========================================================================
async function _initMicrophone() {
  try {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    _assistantAudioCtx = new AudioCtx({ sampleRate: 16000 });
    _assistantMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var source = _assistantAudioCtx.createMediaStreamSource(_assistantMediaStream);

    // Inline worklet via data URI to avoid CORS issues with file:///
    var workletCode = [
      "class AssistantAudioProcessor extends AudioWorkletProcessor {",
      "  constructor() { super(); this.active = false; this.buf = new Int16Array(2048); this.idx = 0;",
      "    this.port.onmessage = (e) => { if (e.data.command === 'init') this.active = true; }; }",
      "  process(inputs) {",
      "    if (!this.active) return true;",
      "    var ch = inputs[0] && inputs[0][0]; if (!ch) return true;",
      "    for (var i = 0; i < ch.length; i++) {",
      "      var s = Math.max(-1, Math.min(1, ch[i]));",
      "      this.buf[this.idx++] = s < 0 ? s * 0x8000 : s * 0x7FFF;",
      "      if (this.idx >= this.buf.length) { this.port.postMessage(new Int16Array(this.buf)); this.idx = 0; }",
      "    } return true; }",
      "} registerProcessor('assistant-audio-proc', AssistantAudioProcessor);"
    ].join("\n");

    var dataUri = "data:application/javascript;base64," + window.btoa(workletCode);
    await _assistantAudioCtx.audioWorklet.addModule(dataUri);

    _assistantWorklet = new AudioWorkletNode(_assistantAudioCtx, "assistant-audio-proc");
    source.connect(_assistantWorklet);

    _assistantWorklet.port.onmessage = function(e) {
      if ((_assistantIsPTT || Date.now() - _assistantPttRelease < 2000) && _assistantConnected) {
        _sendAudioChunk(e.data);
      }
    };
    _assistantWorklet.port.postMessage({ command: "init" });

  } catch (err) {
    console.error("[Assistant] Microphone error:", err);
    _addErrorMessage("Microphone access denied or unavailable.");
  }
}

function _sendAudioChunk(pcm16Array) {
  if (!_assistantWs || _assistantWs.readyState !== WebSocket.OPEN) return;
  var base64 = _bufferToBase64(pcm16Array.buffer);
  var msg = {
    realtimeInput: {
      mediaChunks: [{
        mimeType: "audio/pcm;rate=16000",
        data: base64
      }]
    }
  };
  _assistantWs.send(JSON.stringify(msg));
}

function _bufferToBase64(buffer) {
  var binary = "";
  var bytes = new Uint8Array(buffer);
  for (var i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// =========================================================================
// Audio Playback
// =========================================================================
function _initPlayback() {
  _playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });

  // WOPR metallic voice chain:
  // 1. Bandpass to thin out the voice (telephone/computer quality)
  var bandpass = _playCtx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 1800;
  bandpass.Q.value = 0.8;

  // 2. Peaking resonance at ~2.5kHz for metallic ring
  var resonance = _playCtx.createBiquadFilter();
  resonance.type = "peaking";
  resonance.frequency.value = 2500;
  resonance.gain.value = 6;
  resonance.Q.value = 3;

  // 3. Second resonance at ~1.2kHz for robotic nasal quality
  var resonance2 = _playCtx.createBiquadFilter();
  resonance2.type = "peaking";
  resonance2.frequency.value = 1200;
  resonance2.gain.value = 4;
  resonance2.Q.value = 2.5;

  // 4. Subtle waveshaper for slight harmonic distortion
  var waveshaper = _playCtx.createWaveShaper();
  var curve = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    var x = (i / 128) - 1;
    curve[i] = (Math.PI + 3) * x / (Math.PI + 3 * Math.abs(x));
  }
  waveshaper.curve = curve;
  waveshaper.oversample = "2x";

  // 5. Lowpass to tame harsh highs
  var lowpass = _playCtx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 6000;

  // 6. Compressor to even out the metallic sound
  var compressor = _playCtx.createDynamicsCompressor();
  compressor.threshold.value = -20;
  compressor.ratio.value = 4;

  // Chain: source -> bandpass -> resonance -> resonance2 -> waveshaper -> lowpass -> compressor -> output
  bandpass.connect(resonance);
  resonance.connect(resonance2);
  resonance2.connect(waveshaper);
  waveshaper.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(_playCtx.destination);

  _playFilter = bandpass; // entry point of the chain

  _playNextTime = _playCtx.currentTime;
}

function _playAudioChunk(base64Data) {
  if (!_playCtx) return;
  var binary = window.atob(base64Data);
  var buffer = new ArrayBuffer(binary.length);
  var view = new Uint8Array(buffer);
  for (var i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);

  var int16 = new Int16Array(buffer);
  var float32 = new Float32Array(int16.length);
  for (var i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

  var audioBuffer = _playCtx.createBuffer(1, float32.length, 24000);
  audioBuffer.getChannelData(0).set(float32);

  var src = _playCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(_playFilter);

  if (_playNextTime < _playCtx.currentTime) _playNextTime = _playCtx.currentTime;
  src.start(_playNextTime);
  _playNextTime += audioBuffer.duration;
}

// =========================================================================
// Chat UI Helpers
// =========================================================================
function _getMessagesEl() {
  return document.getElementById("assistantMessages");
}

function _scrollToBottom() {
  var el = _getMessagesEl();
  if (el) el.scrollTop = el.scrollHeight;
}

function _addUserMessage(text) {
  var div = document.createElement("div");
  div.className = "assistant-msg user-msg";
  div.textContent = text;
  _getMessagesEl().appendChild(div);
  _scrollToBottom();
}

function _addSystemMessage(text) {
  var div = document.createElement("div");
  div.className = "assistant-msg system-msg";
  div.innerHTML = "<p>" + text + "</p>";
  _getMessagesEl().appendChild(div);
  _scrollToBottom();
}

function _addErrorMessage(text) {
  var div = document.createElement("div");
  div.className = "assistant-msg error-msg";
  div.textContent = text;
  _getMessagesEl().appendChild(div);
  _scrollToBottom();
}

function _addToolMessage(toolName, args, result) {
  var div = document.createElement("div");
  div.className = "assistant-msg tool-msg";
  var argsStr = Object.keys(args).length > 0 ? JSON.stringify(args, null, 1) : "";
  var statusIcon = result.error ? "\u2717" : "\u2713";
  var statusText = result.error ? ("Error: " + result.error) : "OK";
  div.innerHTML = "<strong>" + statusIcon + " " + toolName + "</strong>" +
    (argsStr ? "<br>" + _escapeHtml(argsStr) : "") +
    "<br><em>" + _escapeHtml(statusText) + "</em>";
  _getMessagesEl().appendChild(div);
  _scrollToBottom();
}

function _showTypingIndicator() {
  _removeTypingIndicator();
  var div = document.createElement("div");
  div.className = "assistant-msg typing-msg";
  div.id = "assistantTyping";
  div.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  _getMessagesEl().appendChild(div);
  _scrollToBottom();
}

function _removeTypingIndicator() {
  var el = document.getElementById("assistantTyping");
  if (el) el.remove();
}

function _appendAiText(text) {
  _removeTypingIndicator();
  if (!_currentAiDiv) {
    _currentAiDiv = document.createElement("div");
    _currentAiDiv.className = "assistant-msg ai-msg";
    _getMessagesEl().appendChild(_currentAiDiv);
    _currentAiText = "";
  }
  _currentAiText += text;
  _currentAiDiv.innerHTML = _formatMarkdown(_currentAiText);
  _scrollToBottom();
}

function _finalizeAiMessage() {
  _removeTypingIndicator();
  _currentAiDiv = null;
  _currentAiText = "";
}

function _escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _formatMarkdown(text) {
  // Basic markdown: bold, italic, code, line breaks
  return _escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code style='background:#1a1a2e;padding:1px 4px;border-radius:3px;font-size:12px;'>$1</code>")
    .replace(/\n/g, "<br>");
}

// =========================================================================
// Status Indicator
// =========================================================================
function _updateStatus(state) {
  var dot = document.getElementById("assistantStatus");
  if (!dot) return;
  dot.className = "ws-status";
  if (state === "connected") dot.classList.add("ws-connected");
  else if (state === "connecting") dot.classList.add("ws-connecting");
  else dot.classList.add("ws-disconnected");
}

// =========================================================================
// API Key Management
// =========================================================================
function _promptApiKey() {
  var key = prompt("Enter your Gemini API Key for the Aircraft Design Assistant.\n(Stored locally in your browser only)");
  if (key && key.trim()) {
    _assistantApiKey = key.trim();
    localStorage.setItem("aircraft_creator_gemini_key", _assistantApiKey);
  }
}

// =========================================================================
// Panel Toggle
// =========================================================================
function _toggleAssistantPanel() {
  document.body.classList.toggle("show-assistant");

  // Auto-connect on first open if API key exists
  if (document.body.classList.contains("show-assistant") && !_assistantConnected && _assistantApiKey) {
    _connectAssistant();
  }
}

function _closeAssistantPanel() {
  document.body.classList.remove("show-assistant");
}

// =========================================================================
// Event Wiring
// =========================================================================
document.addEventListener("DOMContentLoaded", function() {
  // Toggle button
  var toggleBtn = document.getElementById("toggleAssistantBtn");
  if (toggleBtn) toggleBtn.addEventListener("click", _toggleAssistantPanel);

  // Close button
  var closeBtn = document.getElementById("closeAssistantBtn");
  if (closeBtn) closeBtn.addEventListener("click", _closeAssistantPanel);

  // Settings (API key)
  var settingsBtn = document.getElementById("assistantSettingsBtn");
  if (settingsBtn) settingsBtn.addEventListener("click", function() {
    _promptApiKey();
    if (_assistantApiKey && !_assistantConnected) _connectAssistant();
  });

  // Clear chat
  var clearBtn = document.getElementById("assistantClearBtn");
  if (clearBtn) clearBtn.addEventListener("click", function() {
    var el = _getMessagesEl();
    if (el) el.innerHTML = "";
    _addSystemMessage("Chat cleared. Type or speak to continue.");
  });

  // Send button
  var sendBtn = document.getElementById("assistantSendBtn");
  if (sendBtn) sendBtn.addEventListener("click", function() {
    var input = document.getElementById("assistantInput");
    if (input) {
      _sendTextMessage(input.value);
      input.value = "";
      input.style.height = "auto";
    }
  });

  // Text input — Enter to send, Shift+Enter for newline
  var input = document.getElementById("assistantInput");
  if (input) {
    input.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        _sendTextMessage(input.value);
        input.value = "";
        input.style.height = "auto";
      }
    });

    // Auto-resize textarea
    input.addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 100) + "px";
    });
  }

  // Mic button — Push-to-Talk (hold to speak)
  // Microphone is only initialized on first press (lazy init) to avoid permission popup on load
  var micBtn = document.getElementById("assistantMicBtn");
  if (micBtn) {
    async function _startPTT() {
      if (!_assistantConnected) {
        _connectAssistant();
        return;
      }
      // Lazy-init microphone on first PTT press
      if (!_assistantWorklet) {
        await _initMicrophone();
        if (!_assistantWorklet) return; // mic denied
      }
      _assistantIsPTT = true;
      micBtn.classList.add("recording");
    }

    function _stopPTT() {
      _assistantIsPTT = false;
      _assistantPttRelease = Date.now();
      micBtn.classList.remove("recording");
    }

    micBtn.addEventListener("mousedown", function(e) {
      e.preventDefault();
      _startPTT();
    });

    micBtn.addEventListener("mouseup", _stopPTT);

    micBtn.addEventListener("mouseleave", function() {
      if (_assistantIsPTT) _stopPTT();
    });

    // Touch events for mobile
    micBtn.addEventListener("touchstart", function(e) {
      e.preventDefault();
      _startPTT();
    });

    micBtn.addEventListener("touchend", _stopPTT);
  }
});

// =========================================================================
// Exports
// =========================================================================
window.toggleAssistantPanel = _toggleAssistantPanel;
window.connectAssistant = _connectAssistant;
window.disconnectAssistant = _disconnectAssistant;
