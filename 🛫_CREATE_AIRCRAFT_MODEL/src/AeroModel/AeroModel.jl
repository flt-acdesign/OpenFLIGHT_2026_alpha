"""
    AeroModel.jl — Unified Aerodynamic Model Generation Framework

Orchestrates VortexLattice.jl, JAVL (Julia AVL), and JDATCOM backends
to produce dense lookup tables for flight simulator aerodynamic models.
"""
module AeroModel

using JSON
using Dates
using LinearAlgebra
using Printf

# Submodules
include("input.jl")
include("component_split.jl")
include("stall_estimation.jl")
include("vlm_backend.jl")
include("javl_backend.jl")
include("datcom_backend.jl")
include("merge.jl")
include("full_envelope.jl")
include("validation.jl")
include("output.jl")
include("server.jl")

export run_analysis, start_server, start_server_async, AircraftInput

function strip_derived_aero_inputs(aircraft_json::AbstractDict)
    sanitized = deepcopy(Dict{String,Any}(string(k) => v for (k, v) in pairs(aircraft_json)))

    for key in ("stall_parameters", "dynamic_stall", "tail_properties")
        if haskey(sanitized, key)
            delete!(sanitized, key)
        end
    end

    general = get(sanitized, "general", nothing)
    if general isa AbstractDict
        for key in ("Oswald_factor", "sideslip_drag_K", "scale_tail_forces")
            if haskey(general, key)
                delete!(general, key)
            end
        end
    end

    surfaces = get(sanitized, "lifting_surfaces", nothing)
    if surfaces isa AbstractVector
        for surf in surfaces
            if surf isa AbstractDict
                for key in ("Oswald_factor", "aerodynamic_center_pos_xyz_m")
                    if haskey(surf, key)
                        delete!(surf, key)
                    end
                end
            end
        end
    end

    return sanitized
end

"""
    run_analysis(aircraft_json::Dict; progress_callback=nothing) -> Dict

Main entry point. Takes an extended aircraft JSON dictionary,
runs all requested backends, merges results, and returns
the unified aerodynamic model in schema v2.1 format.

`progress_callback(backend, status, percent, message)` is called
for real-time progress reporting.
"""
function run_analysis(aircraft_json::AbstractDict; progress_callback=nothing)
    cb = isnothing(progress_callback) ? (args...) -> nothing : progress_callback
    sanitized_json = strip_derived_aero_inputs(aircraft_json)

    # 1. Parse and validate input
    cb("input", "running", 0, "Parsing aircraft definition...")
    input = parse_aircraft_input(sanitized_json)
    cb("input", "complete", 100, "Input validated.")

    # 2. Determine backends to run
    backends = get(get(sanitized_json, "analysis", Dict()), "backends", ["vlm", "datcom"])
    results = Dict{String,Any}()

    # 3. Run VLM backend
    if "vlm" in backends
        cb("vlm", "running", 0, "Starting VortexLattice analysis...")
        try
            results["vlm"] = run_vlm_backend(input; progress_callback=(s, p, m) -> cb("vlm", s, p, m))
            cb("vlm", "complete", 100, "VLM analysis complete.")
        catch e
            bt = sprint(showerror, e, catch_backtrace())
            cb("vlm", "error", 0, "VLM error: $bt")
            results["vlm"] = nothing
        end
    end

    # 4. Run JAVL backend
    if "javl" in backends
        cb("javl", "running", 0, "Starting Julia AVL analysis...")
        try
            results["javl"] = run_javl_backend(input; progress_callback=(s, p, m) -> cb("javl", s, p, m))
            cb("javl", "complete", 100, "JAVL analysis complete.")
        catch e
            cb("javl", "error", 0, "JAVL error: $(sprint(showerror, e))")
            results["javl"] = nothing
        end
    end

    # 5. Run DATCOM backend
    if "datcom" in backends
        cb("datcom", "running", 0, "Starting DATCOM analysis...")
        try
            results["datcom"] = run_datcom_backend(input; progress_callback=(s, p, m) -> cb("datcom", s, p, m))
            cb("datcom", "complete", 100, "DATCOM analysis complete.")
        catch e
            cb("datcom", "error", 0, "DATCOM error: $(sprint(showerror, e))")
            results["datcom"] = nothing
        end
    end

    # 6. Build full aerobatic envelope (±180°)
    # Always runs — uses VLM linear derivatives when available, otherwise
    # generates all coefficients from geometry-based estimates alone.
    # This ensures CY, Cl, Cn are always populated (DATCOM doesn't compute them).
    cb("envelope", "running", 0, "Building full aerodynamic envelope...")
    vlm_data = get(results, "vlm", nothing)
    results["vlm"] = extend_to_full_envelope(input, vlm_data, sanitized_json)
    cb("envelope", "complete", 100, "Full envelope complete.")

    # 7. Merge results into unified model
    cb("merge", "running", 0, "Merging results...")
    model = merge_results(input, results, sanitized_json)
    cb("merge", "complete", 100, "Model generation complete.")

    # 8. Validate aerodynamic data quality
    cb("validation", "running", 0, "Running quality checks...")
    validation_report = validate_aero_model(model, input)
    if haskey(model, "quality")
        model["quality"]["validation"] = report_to_dict(validation_report)
    else
        model["quality"] = Dict("validation" => report_to_dict(validation_report))
    end
    print_report(validation_report)
    cb("validation", "complete", 100, validation_report.summary)

    return model
end

end # module
