/********************************************
 * FILE: analysis-setup.js
 * Handles analysis configuration, control surfaces,
 * engines, general/mass properties, configurations
 ********************************************/

// ---- Server port (auto-set by RunModelCreator.jl) ----
var aeromodel_port = 8765;  // Auto-set by RunModelCreator.jl

// ---- Default extended data structure ----
// Analysis defaults — applied on fresh load and merged into loaded JSONs
var ANALYSIS_DEFAULTS = {
  alpha_range_DEG: [-180, 180],
  alpha_step_DEG: 2,
  beta_range_DEG: [-180, 180],
  beta_step_DEG: 2,
  mach_values: [0.2],
  altitude_m: 0,
  backends: ["javl", "datcom"],
  beta_zero_beyond_alpha_deg: 20
};

function ensureExtendedData() {
  if (typeof stripDerivedAerodynamicInputs === 'function') {
    stripDerivedAerodynamicInputs(window.aircraftData);
  }
  // Ensure schema_version exists
  if (!window.aircraftData.schema_version) {
    window.aircraftData.schema_version = "2.0";
  }
  // Ensure general has extended fields
  var gen = window.aircraftData.general;
  if (!gen.aircraft_name) gen.aircraft_name = "";
  var resolvedSref = Number(gen.aircraft_reference_area_m2);
  if (!(resolvedSref > 0)) resolvedSref = 10;
  gen.aircraft_reference_area_m2 = resolvedSref;
  if (!gen.aircraft_reference_span_m) gen.aircraft_reference_span_m = 20;
  if (!gen.mass_kg) gen.mass_kg = 5000;
  if (!gen.inertia) {
    gen.inertia = {
      principal_moments_kgm2: { Ixx_p: 1000, Iyy_p: 3000, Izz_p: 3500 },
      principal_axes_rotation_deg: { roll: 0, pitch: 0, yaw: 0 }
    };
  }
  // Ensure configurations exists
  if (!window.aircraftData.configurations) {
    window.aircraftData.configurations = [{ id: "clean", flap_deg: 0, gear: "up" }];
  }
  // Always apply analysis defaults — ensures full [-180,180] sweep ranges
  window.aircraftData.analysis = Object.assign({}, ANALYSIS_DEFAULTS);
  // Ensure engines is an array
  if (!window.aircraftData.engines) {
    window.aircraftData.engines = [];
  }
}
ensureExtendedData();

// ---- Control Surface Management ----
var csCounter = 0;

function createControlSurfaceEntry(data) {
  data = data || {};
  csCounter++;
  var id = 'cs_' + csCounter;

  var div = document.createElement('div');
  div.className = 'control-surface-entry';
  div.dataset.csId = id;

  div.innerHTML = '<div class="cs-header">' +
    '<span>Control Surface #' + csCounter + '</span>' +
    '<button type="button" class="cs-remove" onclick="this.parentElement.parentElement.remove()">Remove</button>' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>Name:</label> <input type="text" class="cs-name" value="' + (data.name || '') + '">' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>Type:</label> <select class="cs-type">' +
    '    <option value="aileron"' + (data.type === 'aileron' ? ' selected' : '') + '>Aileron</option>' +
    '    <option value="elevator"' + (data.type === 'elevator' ? ' selected' : '') + '>Elevator</option>' +
    '    <option value="rudder"' + (data.type === 'rudder' ? ' selected' : '') + '>Rudder</option>' +
    '    <option value="flap"' + (data.type === 'flap' ? ' selected' : '') + '>Flap</option>' +
    '    <option value="spoiler"' + (data.type === 'spoiler' ? ' selected' : '') + '>Spoiler</option>' +
    '  </select>' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>Eta Start:</label> <input type="number" step="0.01" class="cs-eta-start" value="' + (data.eta_start ?? 0.6) + '">' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>Eta End:</label> <input type="number" step="0.01" class="cs-eta-end" value="' + (data.eta_end ?? 0.95) + '">' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>Chord Frac:</label> <input type="number" step="0.01" class="cs-chord-frac" value="' + (data.chord_fraction ?? 0.25) + '">' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>Defl. Range:</label> <input type="text" class="cs-defl-range" value="' + (data.deflection_range_DEG ? data.deflection_range_DEG.join(',') : '-20,20') + '">' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>Gain:</label> <input type="number" step="0.1" class="cs-gain" value="' + (data.gain ?? 1.0) + '">' +
    '</div>';

  return div;
}

function collectControlSurfaces() {
  var container = document.getElementById('ls_control_surfaces_container');
  var entries = container.querySelectorAll('.control-surface-entry');
  var result = [];
  entries.forEach(function(entry) {
    var deflRange = entry.querySelector('.cs-defl-range').value.split(',').map(Number);
    result.push({
      name: entry.querySelector('.cs-name').value,
      type: entry.querySelector('.cs-type').value,
      eta_start: parseFloat(entry.querySelector('.cs-eta-start').value),
      eta_end: parseFloat(entry.querySelector('.cs-eta-end').value),
      chord_fraction: parseFloat(entry.querySelector('.cs-chord-frac').value),
      deflection_range_DEG: deflRange,
      gain: parseFloat(entry.querySelector('.cs-gain').value)
    });
  });
  return result;
}

function populateControlSurfaces(controlSurfaces) {
  var container = document.getElementById('ls_control_surfaces_container');
  container.innerHTML = '';
  if (!controlSurfaces || !Array.isArray(controlSurfaces)) return;
  controlSurfaces.forEach(function(cs) {
    container.appendChild(createControlSurfaceEntry(cs));
  });
}

// Add control surface button
document.getElementById('ls_add_control_surface').addEventListener('click', function() {
  var container = document.getElementById('ls_control_surfaces_container');
  container.appendChild(createControlSurfaceEntry({}));
});

// NOTE: Extended fields (incidence, twist, airfoil, control_surfaces) are now
// handled natively in ui-logic.js — no patching needed.

// ---- Engine Modal ----
(function setupEngineModal() {
  var modal = document.getElementById('engineModal');

  document.getElementById('addEngineBtn').addEventListener('click', function() {
    window.editingType = "";
    window.editingObject = null;
    fillEngineModal({});
  });

  document.getElementById('eng_submit').addEventListener('click', function() {
    var newData = {
      id: document.getElementById('eng_id').value,
      position_m: document.getElementById('eng_position').value.split(',').map(Number),
      orientation_deg: {
        yaw: parseFloat(document.getElementById('eng_yaw').value),
        pitch: parseFloat(document.getElementById('eng_pitch').value),
        roll: parseFloat(document.getElementById('eng_roll').value)
      },
      max_thrust_n: parseFloat(document.getElementById('eng_max_thrust_n').value) || 600,
      thrust_scale: parseFloat(document.getElementById('eng_thrust_scale').value),
      spool_up_1_s: parseFloat(document.getElementById('eng_spool_up').value),
      spool_down_1_s: parseFloat(document.getElementById('eng_spool_down').value),
      reverse_thrust_ratio: parseFloat(document.getElementById('eng_reverse_ratio').value) || 0,
      throttle_channel: parseInt(document.getElementById('eng_throttle_channel').value) || 1
    };

    if (window.editingType === 'engine' && window.editingObject) {
      Object.assign(window.editingObject, newData);
      window.editingObject = null;
      window.editingType = "";
    } else {
      if (!aircraftData.engines) aircraftData.engines = [];
      aircraftData.engines.push(newData);
    }
    modal.style.display = 'none';
    renderAircraft();
    if (typeof triggerAutoReanalysis === 'function') triggerAutoReanalysis();
  });

  document.getElementById('eng_cancel').addEventListener('click', function() {
    modal.style.display = 'none';
    window.editingType = "";
    window.editingObject = null;
  });
})();

function fillEngineModal(data) {
  document.getElementById('eng_id').value = data.id || 'ENG' + ((aircraftData.engines || []).length + 1);
  document.getElementById('eng_position').value = (data.position_m || [0, 0, 0]).join(',');
  var orient = data.orientation_deg || {};
  document.getElementById('eng_yaw').value = orient.yaw ?? 0;
  document.getElementById('eng_pitch').value = orient.pitch ?? 0;
  document.getElementById('eng_roll').value = orient.roll ?? 0;
  document.getElementById('eng_max_thrust_n').value = data.max_thrust_n ?? 600;
  document.getElementById('eng_thrust_scale').value = data.thrust_scale ?? 1.0;
  document.getElementById('eng_spool_up').value = data.spool_up_1_s ?? 1.2;
  document.getElementById('eng_spool_down').value = data.spool_down_1_s ?? 1.0;
  document.getElementById('eng_reverse_ratio').value = data.reverse_thrust_ratio ?? 0;
  document.getElementById('eng_throttle_channel').value = data.throttle_channel ?? 1;
  document.getElementById('engineModal').style.display = 'block';
}

// ---- General / Mass Properties Modal ----
(function setupGeneralModal() {
  var modal = document.getElementById('generalModal');

  document.getElementById('editGeneralBtn').addEventListener('click', function() {
    fillGeneralModal();
  });

  document.getElementById('gen_submit').addEventListener('click', function() {
    var gen = aircraftData.general;
    gen.aircraft_name = document.getElementById('gen_aircraft_name').value;
    gen.aircraft_reference_area_m2 = parseFloat(document.getElementById('gen_sref').value);
    gen.aircraft_reference_mean_aerodynamic_chord_m = parseFloat(document.getElementById('gen_cref').value);
    gen.aircraft_reference_span_m = parseFloat(document.getElementById('gen_bref').value);
    gen.aircraft_CoG_coords_xyz_m = document.getElementById('gen_cog').value.split(',').map(Number);
    gen.mass_kg = parseFloat(document.getElementById('gen_mass').value);

    if (!gen.inertia) gen.inertia = {};
    gen.inertia.principal_moments_kgm2 = {
      Ixx_p: parseFloat(document.getElementById('gen_ixx').value),
      Iyy_p: parseFloat(document.getElementById('gen_iyy').value),
      Izz_p: parseFloat(document.getElementById('gen_izz').value)
    };
    gen.inertia.principal_axes_rotation_deg = {
      roll: parseFloat(document.getElementById('gen_pa_roll').value),
      pitch: parseFloat(document.getElementById('gen_pa_pitch').value),
      yaw: parseFloat(document.getElementById('gen_pa_yaw').value)
    };

    if (typeof stripDerivedAerodynamicInputs === 'function') {
      stripDerivedAerodynamicInputs(aircraftData);
    }

    modal.style.display = 'none';
    // Re-render the 3D model so CoG marker, NP marker, etc. reflect the new values
    if (typeof renderAircraft === 'function') renderAircraft();
    if (window.jsonEditor && window.appState.jsonEditorVisible) {
      updateJsonEditor();
    }
    if (typeof updateValidationStatus === 'function') updateValidationStatus();
    if (typeof triggerAutoReanalysis === 'function') triggerAutoReanalysis();
  });

  document.getElementById('gen_cancel').addEventListener('click', function() {
    modal.style.display = 'none';
  });
})();

function fillGeneralModal() {
  var gen = aircraftData.general;
  document.getElementById('gen_aircraft_name').value = gen.aircraft_name || '';
  document.getElementById('gen_sref').value = gen.aircraft_reference_area_m2 ?? 10;
  document.getElementById('gen_cref').value = gen.aircraft_reference_mean_aerodynamic_chord_m ?? 3;
  document.getElementById('gen_bref').value = gen.aircraft_reference_span_m ?? 20;
  document.getElementById('gen_cog').value = (gen.aircraft_CoG_coords_xyz_m || [0, 0, 0]).join(',');
  document.getElementById('gen_mass').value = gen.mass_kg ?? 5000;

  var inertia = gen.inertia || {};
  var pm = inertia.principal_moments_kgm2 || {};
  document.getElementById('gen_ixx').value = pm.Ixx_p ?? 1000;
  document.getElementById('gen_iyy').value = pm.Iyy_p ?? 3000;
  document.getElementById('gen_izz').value = pm.Izz_p ?? 3500;
  var pa = inertia.principal_axes_rotation_deg || {};
  document.getElementById('gen_pa_roll').value = pa.roll ?? 0;
  document.getElementById('gen_pa_pitch').value = pa.pitch ?? 0;
  document.getElementById('gen_pa_yaw').value = pa.yaw ?? 0;

  document.getElementById('generalModal').style.display = 'block';
}

// ---- Configurations Modal ----
var cfgCounter = 0;

function createConfigEntry(data) {
  data = data || {};
  cfgCounter++;

  var div = document.createElement('div');
  div.className = 'control-surface-entry';
  div.innerHTML = '<div class="cs-header">' +
    '<span>Config #' + cfgCounter + '</span>' +
    '<button type="button" class="cs-remove" onclick="this.parentElement.parentElement.remove()">Remove</button>' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>ID:</label> <input type="text" class="cfg-id" value="' + (data.id || 'clean') + '">' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>Flap (&deg;):</label> <input type="number" step="1" class="cfg-flap" value="' + (data.flap_deg ?? 0) + '">' +
    '</div>' +
    '<div class="form-group">' +
    '  <label>Gear:</label> <select class="cfg-gear">' +
    '    <option value="up"' + (data.gear === 'up' ? ' selected' : '') + '>Up</option>' +
    '    <option value="down"' + (data.gear === 'down' ? ' selected' : '') + '>Down</option>' +
    '  </select>' +
    '</div>';
  return div;
}

(function setupConfigModal() {
  var modal = document.getElementById('configModal');

  document.getElementById('editConfigsBtn').addEventListener('click', function() {
    var container = document.getElementById('cfg_container');
    container.innerHTML = '';
    cfgCounter = 0;
    var configs = aircraftData.configurations || [];
    configs.forEach(function(cfg) {
      container.appendChild(createConfigEntry(cfg));
    });
    modal.style.display = 'block';
  });

  document.getElementById('cfg_add').addEventListener('click', function() {
    var container = document.getElementById('cfg_container');
    container.appendChild(createConfigEntry({}));
  });

  document.getElementById('cfg_submit').addEventListener('click', function() {
    var container = document.getElementById('cfg_container');
    var entries = container.querySelectorAll('.control-surface-entry');
    var configs = [];
    entries.forEach(function(entry) {
      configs.push({
        id: entry.querySelector('.cfg-id').value,
        flap_deg: parseFloat(entry.querySelector('.cfg-flap').value),
        gear: entry.querySelector('.cfg-gear').value
      });
    });
    aircraftData.configurations = configs;
    modal.style.display = 'none';
    if (window.jsonEditor && window.appState.jsonEditorVisible) {
      updateJsonEditor();
    }
  });

  document.getElementById('cfg_cancel').addEventListener('click', function() {
    modal.style.display = 'none';
  });
})();

// ---- Analysis Setup Modal ----
(function setupAnalysisModal() {
  var modal = document.getElementById('analysisModal');

  document.getElementById('openAnalysisBtn').addEventListener('click', function() {
    fillAnalysisModal();
    modal.style.display = 'block';
  });

  document.getElementById('analysis_cancel').addEventListener('click', function() {
    modal.style.display = 'none';
  });

  document.getElementById('analysis_run').addEventListener('click', function() {
    // Collect analysis params
    var analysis = {
      alpha_range_DEG: [
        parseFloat(document.getElementById('analysis_alpha_min').value),
        parseFloat(document.getElementById('analysis_alpha_max').value)
      ],
      alpha_step_DEG: parseFloat(document.getElementById('analysis_alpha_step').value),
      beta_range_DEG: [
        parseFloat(document.getElementById('analysis_beta_min').value),
        parseFloat(document.getElementById('analysis_beta_max').value)
      ],
      beta_step_DEG: parseFloat(document.getElementById('analysis_beta_step').value),
      mach_values: document.getElementById('analysis_mach_values').value.split(',').map(Number),
      altitude_m: parseFloat(document.getElementById('analysis_altitude').value),
      beta_zero_beyond_alpha_deg: parseFloat(document.getElementById('analysis_beta_zero_beyond_alpha').value) || 20,
      backends: []
    };

    if (document.getElementById('analysis_vlm').checked) analysis.backends.push('vlm');
    if (document.getElementById('analysis_javl').checked) analysis.backends.push('javl');
    if (document.getElementById('analysis_datcom').checked) analysis.backends.push('datcom');

    aircraftData.analysis = analysis;
    modal.style.display = 'none';

    // Connect and run
    var wsUrl = document.getElementById('analysis_ws_url').value;
    startAnalysis(wsUrl, aircraftData);
  });
})();

function fillAnalysisModal() {
  var a = aircraftData.analysis || {};
  var range = a.alpha_range_DEG || [-180, 180];
  document.getElementById('analysis_alpha_min').value = range[0];
  document.getElementById('analysis_alpha_max').value = range[1];
  document.getElementById('analysis_alpha_step').value = a.alpha_step_DEG ?? 2;
  var brange = a.beta_range_DEG || [-180, 180];
  document.getElementById('analysis_beta_min').value = brange[0];
  document.getElementById('analysis_beta_max').value = brange[1];
  document.getElementById('analysis_beta_step').value = a.beta_step_DEG ?? 2;
  document.getElementById('analysis_mach_values').value = (a.mach_values || [0.2]).join(',');
  document.getElementById('analysis_altitude').value = a.altitude_m ?? 0;
  document.getElementById('analysis_beta_zero_beyond_alpha').value = a.beta_zero_beyond_alpha_deg ?? 20;

  var backends = a.backends || ['javl', 'datcom'];
  document.getElementById('analysis_vlm').checked = backends.indexOf('vlm') >= 0;
  document.getElementById('analysis_javl').checked = backends.indexOf('javl') >= 0;
  document.getElementById('analysis_datcom').checked = backends.indexOf('datcom') >= 0;
}

// ---- AeroModel Client (MsgPack protocol) ----
// Create the global client instance using the layered pattern:
//   WebSocketClient → MessagePackClient → AeroModelClient
window.aeroClient = new AeroModelClient({ url: 'ws://localhost:' + aeromodel_port });

// Wire up connection status indicator
window.aeroClient
  .onOpen(function() {
    window.aeroClient.updateStatusIndicator('connected');
    addProgressLog('Connected to AeroModel server.');
  })
  .onClose(function() {
    window.aeroClient.updateStatusIndicator('disconnected');
  })
  .onReconnect(function(attempt, max, delay) {
    window.aeroClient.updateStatusIndicator('connecting');
    addProgressLog('Reconnecting... (attempt ' + attempt + '/' + max + ')');
  });

// Wire up domain-specific callbacks
window.aeroClient.onProgress(function(msg) {
  var backendMap = { vlm: 'VLM', javl: 'JAVL', datcom: 'DATCOM' };
  var name = backendMap[msg.backend] || msg.backend;
  var bar = document.getElementById('progressBar' + name);
  var status = document.getElementById('progressStatus' + name);
  if (bar) bar.style.width = (msg.percent || 0) + '%';
  if (status) status.textContent = msg.status || '';
  if (msg.message) addProgressLog('[' + name + '] ' + msg.message);
});

window.aeroClient.onResults(function(model) {
  addProgressLog('Analysis complete!');
  window.aeroModel = model;

  // Compute the complete aircraft neutral point from Cm and CL slopes
  computeNeutralPoint(model);

  showResultsCharts(model);

  // Re-render aircraft so the NP marker appears
  if (typeof renderAircraft === 'function') {
    renderAircraft();
  }

  // Auto-render VLM panel mesh from client-side geometry (always matches solid model)
  if (typeof buildVLMMeshFromGeometry === 'function' && typeof renderVLMMesh === 'function') {
    var geomMesh = buildVLMMeshFromGeometry();
    if (geomMesh && geomMesh.length > 0) {
      renderVLMMesh(geomMesh);
      addProgressLog('VLM mesh rendered from geometry: ' + geomMesh.length + ' surface grids.');
    }
  }
});

window.aeroClient.onError(function(msg) {
  addProgressLog('ERROR: ' + (msg.message || msg));
  if (msg.backend) {
    var backendMap = { vlm: 'VLM', javl: 'JAVL', datcom: 'DATCOM' };
    var name = backendMap[msg.backend] || msg.backend;
    var status = document.getElementById('progressStatus' + name);
    if (status) {
      status.textContent = 'ERROR';
      status.style.color = '#e74c3c';
    }
  }
});

/**
 * Normalize aircraft data before sending to the analysis server.
 * Fills in missing fields with reasonable defaults so the server
 * doesn't fail on optional fields absent in loaded JSON files.
 */
function normalizeForAnalysis(data) {
  if (typeof stripDerivedAerodynamicInputs === 'function') {
    stripDerivedAerodynamicInputs(data);
  }
  if (!data.lifting_surfaces) return;

  data.lifting_surfaces.forEach(function(surf) {
    // Stations: default to root, mid, tip
    if (!surf.stations_eta || !Array.isArray(surf.stations_eta) || surf.stations_eta.length === 0) {
      surf.stations_eta = [0, 0.5, 1];
    }
    // Incidence and twist defaults
    if (surf.incidence_DEG == null) surf.incidence_DEG = 0;
    if (surf.twist_tip_DEG == null) surf.twist_tip_DEG = 0;
    // Airfoil defaults
    if (!surf.airfoil) {
      surf.airfoil = { type: "NACA", root: "2412", tip: "0012" };
    }
    // Gyration radii defaults (estimate from geometry)
    if (!surf.radius_of_giration_pitch_m) {
      var span = Math.sqrt((surf.surface_area_m2 || 10) * (surf.AR || 8));
      surf.radius_of_giration_pitch_m = span * 0.3;
      surf.radius_of_giration_yaw_m = span * 0.35;
      surf.radius_of_giration_roll_m = span * 0.35;
    }
    if (surf.principal_axis_pitch_up_DEG == null) surf.principal_axis_pitch_up_DEG = 0;
    // CoG defaults to root LE
    if (!surf.CoG_pos_xyz_m) {
      surf.CoG_pos_xyz_m = surf.root_LE ? surf.root_LE.slice() : [0, 0, 0];
    }
    // AC defaults: compute from geometry
    if (!surf.aerodynamic_center_pos_xyz_m) {
      if (typeof computeACFromGeometry === 'function') {
        surf.aerodynamic_center_pos_xyz_m = computeACFromGeometry(surf);
      } else {
        surf.aerodynamic_center_pos_xyz_m = surf.root_LE ? surf.root_LE.slice() : [0, 0, 0];
      }
    }
  });
}

// ---- Start Analysis via WebSocket ----
function startAnalysis(wsUrl, aircraftData) {
  // Sync any scene-level position changes back to aircraftData before analysis
  if (typeof syncScenePositionsToData === 'function') {
    syncScenePositionsToData();
  }

  // Normalize data to fill in missing optional fields
  normalizeForAnalysis(aircraftData);

  // Show results panel and progress
  showResultsPanel();
  showProgress();

  // Reset progress bars
  resetProgress();

  if (window.aeroClient.isConnected()) {
    // Already connected — send immediately
    window.aeroClient.runAnalysis(aircraftData);
  } else {
    // Need to connect first, then send once ready
    window.aeroClient.updateStatusIndicator('connecting');
    addProgressLog('Connecting to server at ' + wsUrl + '...');
    window.aeroClient.connect(wsUrl);

    // Poll for connection readiness
    var waitCount = 0;
    var waitInterval = setInterval(function() {
      waitCount++;
      if (window.aeroClient.isConnected()) {
        clearInterval(waitInterval);
        window.aeroClient.runAnalysis(aircraftData);
      } else if (waitCount > 50) { // 5 seconds timeout
        clearInterval(waitInterval);
        addProgressLog('ERROR: Could not connect to server at ' + wsUrl);
        addProgressLog('Make sure the Julia server is running:');
        addProgressLog('  julia -e "include(\\"src/AeroModel/AeroModel.jl\\"); AeroModel.start_server()"');
      }
    }, 100);
  }
}

function resetProgress() {
  ['VLM', 'JAVL', 'DATCOM'].forEach(function(name) {
    var bar = document.getElementById('progressBar' + name);
    var status = document.getElementById('progressStatus' + name);
    if (bar) bar.style.width = '0%';
    if (status) status.textContent = '--';
  });
  var log = document.getElementById('progressLog');
  if (log) log.innerHTML = '';
}

function addProgressLog(msg) {
  var log = document.getElementById('progressLog');
  if (log) {
    log.innerHTML += msg + '\n';
    log.scrollTop = log.scrollHeight;
  }
}

// ---- Neutral Point Computation ----
// Computes the complete aircraft neutral point from analysis results.
// NP is where dCm/dAlpha = 0, i.e. x_NP = x_CoG - (Cm_alpha / CL_alpha) * cref
function computeNeutralPoint(model) {
  if (!model || !model.aerodynamics || !model.aerodynamics.static_coefficients) return;

  var sc = model.aerodynamics.static_coefficients;
  var axes = sc.axes || {};
  var alphas = axes.alpha_deg || [];
  var betas = axes.beta_deg || [0];
  var configs = axes.config || ['clean'];
  var configKey = configs[0];

  if (alphas.length < 3) return;

  // Find alpha index closest to 0
  var a0 = 0, a0Dist = 999;
  for (var i = 0; i < alphas.length; i++) {
    if (Math.abs(alphas[i]) < a0Dist) { a0Dist = Math.abs(alphas[i]); a0 = i; }
  }
  // Need neighbors for slope computation
  if (a0 < 1 || a0 >= alphas.length - 1) return;

  // Find beta index closest to 0
  var b0 = 0, b0Dist = 999;
  for (var j = 0; j < betas.length; j++) {
    if (Math.abs(betas[j]) < b0Dist) { b0Dist = Math.abs(betas[j]); b0 = j; }
  }

  // Extract CL and Cm slopes at alpha~0, beta~0, first Mach
  var clData = sc.CL && sc.CL.values && sc.CL.values[configKey];
  var cmData = sc.Cm && sc.Cm.values && sc.Cm.values[configKey];
  if (!clData || !cmData) return;

  function getVal(data, mi, ai, bi) {
    if (!data || !data[mi]) return 0;
    if (Array.isArray(data[mi][ai])) return data[mi][ai][bi] || 0;
    if (typeof data[mi][ai] === 'number') return data[mi][ai];
    return 0;
  }

  var cl1 = getVal(clData, 0, a0 - 1, b0);
  var cl2 = getVal(clData, 0, a0 + 1, b0);
  var cm1 = getVal(cmData, 0, a0 - 1, b0);
  var cm2 = getVal(cmData, 0, a0 + 1, b0);
  var dAlpha = alphas[a0 + 1] - alphas[a0 - 1];

  if (dAlpha === 0) return;

  var CL_alpha = (cl2 - cl1) / dAlpha; // per degree
  var Cm_alpha = (cm2 - cm1) / dAlpha; // per degree

  if (Math.abs(CL_alpha) < 1e-6) return; // avoid division by zero

  var gen = window.aircraftData.general || {};
  var cog = gen.aircraft_CoG_coords_xyz_m || [0, 0, 0];
  var cref = gen.aircraft_reference_mean_aerodynamic_chord_m || 1;

  // NP_x = x_CoG - (Cm_alpha / CL_alpha) * cref
  var npX = cog[0] - (Cm_alpha / CL_alpha) * cref;
  model.neutral_point_x_m = npX;

  var sm = ((npX - cog[0]) / cref * 100).toFixed(1);
  addProgressLog('Neutral Point: x = ' + npX.toFixed(3) + ' m, Static Margin = ' + sm + '% MAC');
}

// ---- Graphics Settings Modal ----
(function setupGraphicsSettingsModal() {
  var modal = document.getElementById('graphicsSettingsModal');
  if (!modal) return;

  document.getElementById('openGraphicsSettingsBtn').addEventListener('click', function() {
    // Sync current state into the modal fields
    var cubeEl = document.getElementById('gfx_show_cube');
    var cubeSizeEl = document.getElementById('gfx_cube_size');
    var cubeOpacityEl = document.getElementById('gfx_cube_opacity');
    var groundEl = document.getElementById('gfx_show_ground');
    var axesEl = document.getElementById('gfx_show_axes');

    if (window.originBox) {
      cubeEl.checked = window.originBox.isEnabled();
      cubeSizeEl.value = window.originBox.scaling.x;
      cubeOpacityEl.value = window.originBox.material ? window.originBox.material.alpha : 0.4;
    }
    if (window.ground) {
      groundEl.checked = window.ground.isVisible;
    }
    // Axes visibility
    var axisX = window.scene ? window.scene.getMeshByName('axisX') : null;
    if (axisX) {
      axesEl.checked = axisX.isEnabled();
    }

    // Parallel view
    var parallelEl = document.getElementById('gfx_parallel_view');
    if (parallelEl && window.camera) {
      parallelEl.checked = (window.camera.mode === BABYLON.Camera.ORTHOGRAPHIC_CAMERA);
    }

    modal.style.display = 'block';
  });

  document.getElementById('gfx_apply').addEventListener('click', function() {
    var showCube = document.getElementById('gfx_show_cube').checked;
    var cubeSize = parseFloat(document.getElementById('gfx_cube_size').value) || 1;
    var cubeOpacity = parseFloat(document.getElementById('gfx_cube_opacity').value);
    var showGround = document.getElementById('gfx_show_ground').checked;
    var showAxes = document.getElementById('gfx_show_axes').checked;

    // Origin cube
    if (window.originBox) {
      window.originBox.setEnabled(showCube);
      window.originBox.scaling = new BABYLON.Vector3(cubeSize, cubeSize, cubeSize);
      if (window.originBox.material) {
        window.originBox.material.alpha = Math.max(0, Math.min(1, cubeOpacity));
      }
    }

    // Ground
    if (window.ground) {
      window.ground.isVisible = showGround;
    }

    // Axes
    var axisNames = ['axisX', 'axisY', 'axisZ', 'axisProjX', 'axisProjZ', 'originToGround', 'originMarker'];
    axisNames.forEach(function(name) {
      var mesh = window.scene ? window.scene.getMeshByName(name) : null;
      if (mesh) mesh.setEnabled(showAxes);
    });
    if (window.originGroundLine) window.originGroundLine.setEnabled(showAxes);

    // Parallel view
    var parallelView = document.getElementById('gfx_parallel_view').checked;
    if (typeof toggleParallelView === 'function') {
      toggleParallelView(parallelView);
    }

    modal.style.display = 'none';
  });

  document.getElementById('gfx_cancel').addEventListener('click', function() {
    modal.style.display = 'none';
  });
})();
