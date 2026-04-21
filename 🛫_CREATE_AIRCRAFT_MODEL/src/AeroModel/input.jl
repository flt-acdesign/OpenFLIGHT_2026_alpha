"""
    input.jl — Aircraft input parsing and validation

Reads the extended aircraft JSON and produces a structured AircraftInput
that all backends can consume.
"""

struct ControlSurface
    name::String
    type::String          # "aileron", "elevator", "rudder", "flap", "spoiler"
    eta_start::Float64
    eta_end::Float64
    chord_fraction::Float64
    deflection_range_DEG::Tuple{Float64,Float64}
    gain::Float64
end

struct Airfoil
    type::String          # "NACA" or "custom"
    root::String
    tip::String
    # Parsed geometry (computed from NACA code or explicit JSON overrides)
    root_thickness_ratio::Float64
    root_max_camber::Float64
    root_camber_position::Float64
    tip_thickness_ratio::Float64
    tip_max_camber::Float64
    tip_camber_position::Float64
end

struct LiftingSurface
    name::String
    role::String              # "wing", "horizontal_stabilizer", "vertical_stabilizer", "canard", "other"
    mass_kg::Float64
    root_LE::Vector{Float64}
    AR::Float64
    TR::Float64
    mirror::Bool
    symmetric::Bool
    dihedral_DEG::Float64
    vertical::Bool
    sweep_quarter_chord_DEG::Float64
    surface_area_m2::Float64
    Oswald_factor::Float64
    mean_aerodynamic_chord_m::Float64
    incidence_DEG::Float64
    twist_tip_DEG::Float64
    airfoil::Airfoil
    control_surfaces::Vector{ControlSurface}
end

struct Fuselage
    name::String
    diameter::Float64
    length::Float64
    nose_position::Vector{Float64}
end

struct Engine
    id::String
    position_m::Vector{Float64}
    orientation_deg::Dict{String,Float64}
    thrust_scale::Float64
    max_thrust_n::Float64
    reverse_thrust_ratio::Float64
    throttle_channel::Int
    spool_up_1_s::Float64
    spool_down_1_s::Float64
end

struct InertiaData
    principal_moments_kgm2::Dict{String,Float64}
    principal_axes_rotation_deg::Dict{String,Float64}
end

struct GeneralData
    aircraft_name::String
    Sref::Float64
    cref::Float64
    bref::Float64
    CoG::Vector{Float64}
    mass_kg::Float64
    inertia::InertiaData
end

struct Configuration
    id::String
    flap_deg::Float64
    gear::String
end

struct AnalysisConfig
    alpha_range_DEG::Tuple{Float64,Float64}
    alpha_step_DEG::Float64
    beta_range_DEG::Tuple{Float64,Float64}
    beta_step_DEG::Float64
    mach_values::Vector{Float64}
    altitude_m::Float64
    backends::Vector{String}
end

struct AircraftInput
    general::GeneralData
    lifting_surfaces::Vector{LiftingSurface}
    fuselages::Vector{Fuselage}
    engines::Vector{Engine}
    configurations::Vector{Configuration}
    analysis::AnalysisConfig
end

# ---- Parsing functions ----

function parse_control_surface(d::Dict)
    dr = get(d, "deflection_range_DEG", [-20.0, 20.0])
    ControlSurface(
        get(d, "name", ""),
        get(d, "type", "aileron"),
        Float64(get(d, "eta_start", 0.6)),
        Float64(get(d, "eta_end", 0.95)),
        Float64(get(d, "chord_fraction", 0.25)),
        (Float64(dr[1]), Float64(dr[2])),
        Float64(get(d, "gain", 1.0))
    )
end

function default_tail_control_surface(surface_name::String, cs_type::String)
    if cs_type == "elevator"
        return ControlSurface(
            surface_name * "_elevator",
            "elevator",
            0.15,
            0.95,
            0.28,
            (-25.0, 20.0),
            1.0
        )
    elseif cs_type == "rudder"
        return ControlSurface(
            surface_name * "_rudder",
            "rudder",
            0.10,
            0.95,
            0.35,
            (-25.0, 25.0),
            1.0
        )
    end

    error("Unsupported default control surface type: $cs_type")
end

function ensure_default_tail_controls!(cs_list::Vector{ControlSurface},
                                       surface_name::String,
                                       role::String,
                                       vertical::Bool)
    has_type(type_name::String) = any(cs -> lowercase(cs.type) == type_name, cs_list)

    if role == "horizontal_stabilizer" && !has_type("elevator")
        push!(cs_list, default_tail_control_surface(surface_name, "elevator"))
    elseif (role == "vertical_stabilizer" || vertical) && !has_type("rudder")
        push!(cs_list, default_tail_control_surface(surface_name, "rudder"))
    end
end

"""
    parse_naca_geometry(code::String) -> NamedTuple

Extract thickness ratio (t/c), max camber fraction, camber position,
and leading-edge radius index from a NACA designation string.

Supports:
  - 4-digit  (e.g. "2412"): camber, position, thickness
  - 5-digit  (e.g. "23015"): design CL, position, reflex flag, thickness
  - Symmetric (e.g. "0012"): zero camber, thickness only
"""
function parse_naca_geometry(code::String)
    code = strip(code)

    # Default fallback
    t_over_c = 0.12
    max_camber = 0.0
    camber_pos = 0.0

    if length(code) == 4
        # NACA 4-digit: MPTT
        m = parse(Int, code[1:1]) / 100.0    # max camber fraction
        p = parse(Int, code[2:2]) / 10.0     # camber position (fraction of chord)
        t = parse(Int, code[3:4]) / 100.0    # thickness ratio
        t_over_c = t
        max_camber = m
        camber_pos = p
    elseif length(code) == 5
        # NACA 5-digit: LPSTT
        L = parse(Int, code[1:1])
        P = parse(Int, code[2:2])
        t = parse(Int, code[4:5]) / 100.0
        t_over_c = t
        design_cl = L * 0.15
        max_camber = design_cl / (4π)
        camber_pos = P / 20.0
    else
        if length(code) >= 2
            tt = tryparse(Int, code[end-1:end])
            if !isnothing(tt) && tt > 0 && tt < 50
                t_over_c = tt / 100.0
            end
        end
    end

    # Leading-edge radius: r_LE/c ≈ 1.1019 × (t/c)² for NACA 4-digit family
    le_radius_fraction = 1.1019 * t_over_c^2
    le_sharpness = le_radius_fraction / max(t_over_c, 0.01)

    return (thickness_ratio = t_over_c,
            max_camber = max_camber,
            camber_position = camber_pos,
            le_radius_fraction = le_radius_fraction,
            le_sharpness = le_sharpness)
end

function parse_airfoil(d)
    if d isa Dict
        atype = get(d, "type", "NACA")
        root_code = get(d, "root", "2412")
        tip_code  = get(d, "tip", "0012")
    else
        atype = "NACA"
        root_code = "2412"
        tip_code  = "0012"
    end

    # Parse NACA geometry or use explicit overrides from JSON
    root_g = parse_naca_geometry(root_code)
    tip_g  = parse_naca_geometry(tip_code)

    # Allow explicit JSON overrides for custom airfoils
    rt_tc = d isa Dict ? Float64(get(d, "root_thickness_ratio", root_g.thickness_ratio)) : root_g.thickness_ratio
    rt_mc = d isa Dict ? Float64(get(d, "root_max_camber", root_g.max_camber))           : root_g.max_camber
    rt_cp = d isa Dict ? Float64(get(d, "root_camber_position", root_g.camber_position)) : root_g.camber_position
    tp_tc = d isa Dict ? Float64(get(d, "tip_thickness_ratio", tip_g.thickness_ratio))   : tip_g.thickness_ratio
    tp_mc = d isa Dict ? Float64(get(d, "tip_max_camber", tip_g.max_camber))             : tip_g.max_camber
    tp_cp = d isa Dict ? Float64(get(d, "tip_camber_position", tip_g.camber_position))   : tip_g.camber_position

    Airfoil(atype, root_code, tip_code, rt_tc, rt_mc, rt_cp, tp_tc, tp_mc, tp_cp)
end

"""Auto-detect surface role from its name."""
function auto_detect_role(name::String)
    n = lowercase(name)
    if occursin(r"h.?tail|horizontal|elevator|stabilat", n)
        return "horizontal_stabilizer"
    elseif occursin(r"v.?tail|vertical|fin|rudder", n)
        return "vertical_stabilizer"
    elseif occursin(r"canard", n)
        return "canard"
    elseif occursin(r"wing|main", n)
        return "wing"
    end
    return "other"
end

"""
Estimate Oswald efficiency factor from aspect ratio so the aircraft
definition does not need to provide this aerodynamic tuning input.
"""
function estimate_oswald_factor(AR::Real)
    ar = max(Float64(AR), 0.1)
    e = 1.78 * (1 - 0.045 * ar^0.68) - 0.64
    return clamp(e, 0.55, 0.95)
end

function parse_lifting_surface(d::Dict)
    cs_list = ControlSurface[]
    if haskey(d, "control_surfaces") && d["control_surfaces"] isa Vector
        for cs in d["control_surfaces"]
            push!(cs_list, parse_control_surface(cs))
        end
    end

    name = get(d, "name", "")
    role = get(d, "role", auto_detect_role(name))
    vertical = Bool(get(d, "vertical", false))
    ensure_default_tail_controls!(cs_list, name, role, vertical)

    AR = Float64(get(d, "AR", 8.0))
    TR = Float64(get(d, "TR", 0.6))
    sweep_quarter_chord_DEG = Float64(get(d, "sweep_quarter_chord_DEG", 0.0))

    LiftingSurface(
        name,
        role,
        Float64(get(d, "mass_kg", 0.0)),
        Float64.(get(d, "root_LE", [0.0, 0.0, 0.0])),
        AR,
        TR,
        get(d, "mirror", false),
        get(d, "symmetric", true),
        Float64(get(d, "dihedral_DEG", 0.0)),
        vertical,
        sweep_quarter_chord_DEG,
        Float64(get(d, "surface_area_m2", 10.0)),
        estimate_oswald_factor(AR),
        Float64(get(d, "mean_aerodynamic_chord_m", 2.0)),
        Float64(get(d, "incidence_DEG", 0.0)),
        Float64(get(d, "twist_tip_DEG", 0.0)),
        parse_airfoil(get(d, "airfoil", nothing)),
        cs_list
    )
end

function parse_fuselage(d::Dict)
    Fuselage(
        get(d, "name", ""),
        Float64(get(d, "diameter", 2.0)),
        Float64(get(d, "length", 10.0)),
        Float64.(get(d, "nose_position", [0.0, 0.0, 0.0]))
    )
end

function parse_engine(d::Dict)
    orient = get(d, "orientation_deg", Dict())
    Engine(
        get(d, "id", "ENG1"),
        Float64.(get(d, "position_m", [0.0, 0.0, 0.0])),
        Dict("yaw" => Float64(get(orient, "yaw", 0.0)),
             "pitch" => Float64(get(orient, "pitch", 0.0)),
             "roll" => Float64(get(orient, "roll", 0.0))),
        Float64(get(d, "thrust_scale", 1.0)),
        Float64(get(d, "max_thrust_n", 35000.0)),
        Float64(get(d, "reverse_thrust_ratio", 0.0)),
        Int(get(d, "throttle_channel", 1)),
        Float64(get(d, "spool_up_1_s", 1.2)),
        Float64(get(d, "spool_down_1_s", 1.0))
    )
end

function parse_inertia(d)
    if d isa Dict
        pm = get(d, "principal_moments_kgm2", Dict())
        pa = get(d, "principal_axes_rotation_deg", Dict())
        InertiaData(
            Dict("Ixx_p" => Float64(get(pm, "Ixx_p", 1000.0)),
                 "Iyy_p" => Float64(get(pm, "Iyy_p", 3000.0)),
                 "Izz_p" => Float64(get(pm, "Izz_p", 3500.0))),
            Dict("roll" => Float64(get(pa, "roll", 0.0)),
                 "pitch" => Float64(get(pa, "pitch", 0.0)),
                 "yaw" => Float64(get(pa, "yaw", 0.0)))
        )
    else
        InertiaData(
            Dict("Ixx_p" => 1000.0, "Iyy_p" => 3000.0, "Izz_p" => 3500.0),
            Dict("roll" => 0.0, "pitch" => 0.0, "yaw" => 0.0)
        )
    end
end

function resolve_reference_area_m2(gen_d)::Float64
    if haskey(gen_d, "aircraft_reference_area_m2")
        value = try
            Float64(gen_d["aircraft_reference_area_m2"])
        catch
            NaN
        end
        if isfinite(value) && value > 0
            return value
        end
    end
    return 10.0
end

function parse_aircraft_input(json::Dict)::AircraftInput
    gen_d = get(json, "general", Dict())
    general = GeneralData(
        get(gen_d, "aircraft_name", "Aircraft"),
        resolve_reference_area_m2(gen_d),
        Float64(get(gen_d, "aircraft_reference_mean_aerodynamic_chord_m", 2.0)),
        Float64(get(gen_d, "aircraft_reference_span_m", 20.0)),
        Float64.(get(gen_d, "aircraft_CoG_coords_xyz_m", [0.0, 0.0, 0.0])),
        Float64(get(gen_d, "mass_kg", 5000.0)),
        parse_inertia(get(gen_d, "inertia", nothing))
    )

    surfaces = LiftingSurface[]
    for s in get(json, "lifting_surfaces", [])
        push!(surfaces, parse_lifting_surface(s))
    end

    fuselages = Fuselage[]
    for f in get(json, "fuselages", [])
        push!(fuselages, parse_fuselage(f))
    end

    engines = Engine[]
    for e in get(json, "engines", [])
        push!(engines, parse_engine(e))
    end

    configs = Configuration[]
    for c in get(json, "configurations", [Dict("id" => "clean", "flap_deg" => 0, "gear" => "up")])
        push!(configs, Configuration(
            get(c, "id", "clean"),
            Float64(get(c, "flap_deg", 0.0)),
            get(c, "gear", "up")
        ))
    end

    analysis_d = get(json, "analysis", Dict())
    alpha_r = get(analysis_d, "alpha_range_DEG", [-180.0, 180.0])
    beta_r = get(analysis_d, "beta_range_DEG", [-180.0, 180.0])

    analysis = AnalysisConfig(
        (Float64(alpha_r[1]), Float64(alpha_r[2])),
        Float64(get(analysis_d, "alpha_step_DEG", 2.0)),
        (Float64(beta_r[1]), Float64(beta_r[2])),
        Float64(get(analysis_d, "beta_step_DEG", 2.0)),
        Float64.(get(analysis_d, "mach_values", [0.2])),
        Float64(get(analysis_d, "altitude_m", 0.0)),
        String.(get(analysis_d, "backends", ["vlm", "datcom"]))
    )

    AircraftInput(general, surfaces, fuselages, engines, configs, analysis)
end

# ---- Utility: compute alpha/beta/mach arrays from config ----

"""
    build_nonuniform_grid(lo, hi, fine_step, coarse_step, fine_limit)

Build a sorted, unique grid that uses `fine_step` between `[-fine_limit, fine_limit]`
and `coarse_step` outside that range.  Boundaries ±fine_limit and the endpoints
are always included so that interpolation across the transition is seamless.
"""
function build_nonuniform_grid(lo::Float64, hi::Float64,
                               fine_step::Float64, coarse_step::Float64,
                               fine_limit::Float64)
    pts = Set{Float64}()

    # Coarse region: lo … -fine_limit
    if lo < -fine_limit
        for v in lo:coarse_step:(-fine_limit)
            push!(pts, v)
        end
        push!(pts, -fine_limit)   # ensure boundary is present
    end

    # Fine region: -fine_limit … +fine_limit  (clipped to [lo, hi])
    fine_lo = max(lo, -fine_limit)
    fine_hi = min(hi,  fine_limit)
    for v in fine_lo:fine_step:fine_hi
        push!(pts, v)
    end
    push!(pts, fine_hi)

    # Coarse region: +fine_limit … hi
    if hi > fine_limit
        push!(pts, fine_limit)    # ensure boundary is present
        for v in fine_limit:coarse_step:hi
            push!(pts, v)
        end
    end

    push!(pts, lo)
    push!(pts, hi)

    return sort(collect(pts))
end

function get_alpha_array(ac::AnalysisConfig)
    build_nonuniform_grid(ac.alpha_range_DEG[1], ac.alpha_range_DEG[2],
                          ac.alpha_step_DEG, 5.0, 30.0)
end

function get_beta_array(ac::AnalysisConfig)
    build_nonuniform_grid(ac.beta_range_DEG[1], ac.beta_range_DEG[2],
                          ac.beta_step_DEG, 5.0, 30.0)
end

"""
    get_coarse_alpha_array(ac)

Coarser α-grid for dynamic derivatives whose α-dependence is smooth (tanh
transitions, cos α factors).  Uses a 10° fine step inside ±30° — enough to
resolve the stall-region tanh transitions used by the full-envelope
damping models — and the same 15° coarse step outside.  Typical size is
about 0.6× the `get_alpha_array` grid, reducing simulator table bulk and
per-tick interpolation cost.
"""
function get_coarse_alpha_array(ac::AnalysisConfig)
    build_nonuniform_grid(ac.alpha_range_DEG[1], ac.alpha_range_DEG[2],
                          10.0, 15.0, 30.0)
end

"""
    get_coarse_beta_array(ac)

Coarser β-grid used by the interference block (downwash, sidewash,
η_h, η_v) whose β-dependence is purely smooth (tanh + Gaussian
saturation).  Uses a 10° fine step inside ±30°, 15° outside.
"""
function get_coarse_beta_array(ac::AnalysisConfig)
    build_nonuniform_grid(ac.beta_range_DEG[1], ac.beta_range_DEG[2],
                          10.0, 15.0, 30.0)
end

# ---- Utility: compute planform geometry ----
function wing_planform(surf::LiftingSurface)
    area = surf.surface_area_m2
    AR = surf.AR
    TR = surf.TR
    sweep25 = deg2rad(surf.sweep_quarter_chord_DEG)
    dihedral = deg2rad(surf.dihedral_DEG)

    span = sqrt(area * AR)
    semi_span = span / 2
    root_chord = 2 * area / (span * (1 + TR))
    tip_chord = root_chord * TR
    mac = (2/3) * root_chord * (1 + TR + TR^2) / (1 + TR)
    sweep_le = atan(tan(sweep25) + 0.25 * (1 - TR) * root_chord / semi_span)

    return (root_chord=root_chord, tip_chord=tip_chord, semi_span=semi_span,
            mac=mac, sweep_le=sweep_le, span=span, dihedral=dihedral)
end
