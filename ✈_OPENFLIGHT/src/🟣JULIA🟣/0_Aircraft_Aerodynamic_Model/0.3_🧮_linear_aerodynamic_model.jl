###########################################
# Linear aerodynamic model
#
# A self-contained, well-behaved aerodynamic path that bypasses the full
# coefficient tables and relies exclusively on the scalar stability and
# control derivatives stored in `aircraft_data`.
#
# Motivation
# ----------
# The full table-lookup path is complex, depends on DATCOM/VortexLattice
# exports of varying quality, and has proven susceptible to subtle problems
# in the post-stall region (e.g. non-restoring Cm curves that create false
# high-α trims, or Cl_p values that collapse toward zero).  This module is
# deliberately simple, numerically conservative, and uses only quantities
# that a pilot or aerodynamicist can reason about directly:
#
#     CL_0, CL_alpha, CL_delta_e,
#     CD_0, Oswald_factor, AR,
#     CY_beta, CY_delta_r,
#     Cl_beta, Cl_p, Cl_r, Cl_delta_a, Cl_delta_r,
#     Cm_0, Cm_alpha, Cm_q, Cm_delta_e,
#     Cn_beta, Cn_p, Cn_r, Cn_delta_a, Cn_delta_r
#
# The convention throughout this module is the standard one used in
# aerodynamics textbooks (Etkin/Reid, Roskam, Yechout):
#     * Body axes are [x_fwd, y_right, z_down].
#     * α = atan(w_std / u_std), β = asin(v_std / |V|).
#     * Positive elevator δe = trailing-edge DOWN (pitch-down).
#     * Positive aileron   δa = right-wing-down.
#     * Positive rudder    δr = nose-right (trailing-edge LEFT).
#     * Non-dim rates: p_hat = p·b/(2V), q_hat = q·c/(2V), r_hat = r·b/(2V).
#
# Sim sign convention (EMPIRICAL, verified on PC21 2026-04-11):
#
# The sim integrator already produces physically correct rotations when the
# scalar body rates [p_sim, r_sim, q_sim] and the sim-frame moment vector
# [L_sim, N_sim, M_sim] are used WITHOUT any sign flip between std-aero and
# sim conventions. In other words, treat the sim body frame as if it were
# the standard aero body frame at the scalar level — the quaternion /
# rotation plumbing already accounts for the y_up vs z_down basis mismatch.
#
# Any attempt to "correctly" flip the pitch/yaw rate scalars or M_sim slots
# based on the basis transform (y_up = -z_down, z_left = -y_right) breaks
# the controls: stick back ends up giving nose down, right rudder gives
# nose left, and static pitch stability drives divergently into a stall.
#
# Forces: the wind→body rotation is followed by the simulator-body
# ordering swap [Fx, -Fz, -Fy] — this IS empirically correct and matches
# the backup.
#
# Stall handling
# --------------
# For |α| ≤ α_stall the linear model is used as-is.  Between α_stall and
# α_stall + 10°, CL smoothly transitions toward a post-stall flat-plate
# model CL_post = k_post · sin(2α); CD smoothly transitions toward
# CD_post = CD_floor + (CD_peak − CD_floor)·sin²α.  Cm also receives a
# parametric restoring contribution −Cm_post_scale · sin(2α) so the pitch
# moment always drives α back toward zero in the post-stall region.
###########################################

const _LINEAR_STALL_BLEND_DEG = 10.0   # width of pre→post-stall blend (degrees)
const _LINEAR_CL_POST_SCALE   = 1.10
const _LINEAR_CD_POST_FLOOR   = 0.05
const _LINEAR_CD_POST_PEAK    = 1.60

# Set to true to print one debug line per call (α, β, demands, coefficients,
# sim-frame moments, sim-frame rates). Leave false in normal operation.
const LINEAR_AERO_DEBUG = false
const LINEAR_AERO_DEBUG_EVERY_N_FRAMES = 60   # ≈ once per second at 60 Hz
const _LINEAR_AERO_DEBUG_COUNTER = Ref{Int}(0)

# Guard so the "floors applied" report is printed only once per process.
const _LINEAR_AERO_FLOOR_REPORTED = Ref{Bool}(false)
# Post-stall Cm amplitude.  The post-stall model is −K·sin(2α), whose slope
# at α=0 is −2K.  We set K = |Cm_alpha| / 2 at runtime so the post-stall
# curve joins the pre-stall linear curve with matching slope at α=0 and
# stays the same order of magnitude through the whole envelope.  This
# prevents the aircraft from losing pitch stiffness the moment it crosses
# into stall.

"""
    _soft_saturate(x, x_min, x_max, softness)

Smoothly clips `x` to `[x_min, x_max]`.  Inside the envelope the function
is essentially the identity (slope 1, so no interference with the linear
stability derivatives).  Above `x_max` or below `x_min` it smoothly
approaches the limit with a transition scale of `softness`.

Implementation note: this is the composition of a "soft minimum" with
`x_max` and a "soft maximum" with `x_min`, both built from the numerically
stable softplus function `softplus(z, s) = s·log(1 + exp(z/s))`.  When
`softness ≤ 0`, it falls back to the plain `clamp`.
"""
function _soft_saturate(x::Float64, x_min::Float64, x_max::Float64, softness::Float64)
    if softness <= 0.0
        return clamp(x, x_min, x_max)
    end
    # Numerically stable softplus.
    _softplus(z::Float64) =
        z > 0.0 ? z + softness * log1p(exp(-z / softness)) :
                   softness * log1p(exp(z / softness))

    # Soft minimum with x_max:  smooth_min(x, x_max) = x_max − softplus(x_max − x)
    soft_upper_clipped = x_max - _softplus(x_max - x)
    # Soft maximum with x_min:  smooth_max(⋅, x_min) = x_min + softplus(⋅ − x_min)
    return x_min + _softplus(soft_upper_clipped - x_min)
end

function _linear_stall_blend_weight(alpha_deg::Float64, alpha_stall_positive_deg::Float64, alpha_stall_negative_deg::Float64)
    if alpha_deg >= 0.0
        threshold = max(alpha_stall_positive_deg, 1.0)
        return _smoothstep01((alpha_deg - threshold) / _LINEAR_STALL_BLEND_DEG)
    else
        threshold = min(alpha_stall_negative_deg, -1.0)
        return _smoothstep01((-alpha_deg - (-threshold)) / _LINEAR_STALL_BLEND_DEG)
    end
end

"""
    linear_aero_constant(aircraft_data, symbol_name, default_value)

Thin helper around `getproperty`/`get` that fetches a linear aerodynamic
constant from `aircraft_data` (the named tuple built in 0.1) and falls
back to `default_value` when absent.
"""
function linear_aero_constant(aircraft_data, name::Symbol, default_value::Float64)
    if hasproperty(aircraft_data, name)
        value = getproperty(aircraft_data, name)
        if value isa Number && isfinite(value)
            return Float64(value)
        end
    end
    return default_value
end

"""
    compute_linear_aerodynamic_forces_and_moments(
        initial_flight_conditions,
        control_demand_vector_attained,
        aircraft_data
    )

Compute total aerodynamic force (N) and moment (N·m) in the simulator body
frame using the scalar linear stability & control derivatives from
`aircraft_data`.  Returns a NamedTuple:

    (aero_force_body_sim_N, aero_moment_body_sim_Nm,
     CL_total, CD_total, CS_total, Cl_total, Cm_total, Cn_total,
     elevator_deg, aileron_deg, rudder_deg)
"""
function compute_linear_aerodynamic_forces_and_moments(
    initial_flight_conditions,
    control_demand_vector_attained,
    aircraft_data,
)
    alpha_rad = initial_flight_conditions.alpha_rad
    beta_rad  = initial_flight_conditions.beta_rad
    alpha_deg = rad2deg(alpha_rad)

    V       = initial_flight_conditions.v_body_magnitude
    q_inf   = initial_flight_conditions.dynamic_pressure
    S_ref   = aircraft_data.reference_area
    b_ref   = aircraft_data.reference_span
    c_ref   = aircraft_data.wing_mean_aerodynamic_chord

    p_sim = initial_flight_conditions.p_roll_rate
    r_sim = initial_flight_conditions.r_yaw_rate
    q_sim = initial_flight_conditions.q_pitch_rate

    # EMPIRICAL sign convention (verified by user test 2026-04-11 with PC21):
    # the sim integrator treats the sim-frame rate scalars AND the sim-frame
    # moment-vector components as numerically equal to their std-aero scalars
    # — no flip. Attempting to flip r/q and M_sim[2,3] (per theoretical basis
    # transform) reverses pitch and yaw controls and destabilises pitch.
    # Keep this configuration until a concrete test proves otherwise.
    p_std = p_sim
    r_std = r_sim
    q_std = q_sim

    two_V_safe = 2.0 * V + 1.0e-3
    p_hat = p_std * b_ref / two_V_safe
    q_hat = q_std * c_ref / two_V_safe
    r_hat = r_std * b_ref / two_V_safe

    # Rate-augmented damping factor: a dimensionless quadratic that smoothly
    # grows the damping term as |rate_hat| approaches the physical limit
    # around 0.15-0.20.  At small rate_hat this is ≈ 1, leaving the usual
    # linear stability derivatives untouched.  At large rate_hat it acts
    # like a stall-driven non-linear damping term, capping steady-state
    # rates at physical values regardless of speed.  k=50 is chosen so
    # the augmentation becomes significant (factor ≥ 1.5) once rate_hat
    # exceeds ~0.1, corresponding to body rates of roughly 150-200 deg/s.
    _rate_cap_k = 50.0
    damp_aug_p = 1.0 + _rate_cap_k * p_hat * p_hat
    damp_aug_q = 1.0 + _rate_cap_k * q_hat * q_hat
    damp_aug_r = 1.0 + _rate_cap_k * r_hat * r_hat

    # Control surface deflections in degrees, matching the long-standing
    # convention in compute_aerodynamic_moment_coeffs.jl:
    #   stick back (pitch_demand = +1) → elevator TE UP → negative δe
    #   right aileron (roll_demand = +1) → right-wing-down command → positive δa
    #   right pedal (yaw_demand = +1) → nose-right command → positive δr
    # These chain through the textbook sign conventions for Cl_δa, Cm_δe,
    # Cn_δr to produce correct visual response after the slot-2 / slot-3
    # negations in the moment output (see below).
    pitch_demand = control_demand_vector_attained.pitch_demand_attained
    roll_demand  = control_demand_vector_attained.roll_demand_attained
    yaw_demand   = control_demand_vector_attained.yaw_demand_attained

    elevator_deg = -pitch_demand * aircraft_data.max_elevator_deflection_deg
    aileron_deg  =  roll_demand  * aircraft_data.max_aileron_deflection_deg
    rudder_deg   =  yaw_demand   * aircraft_data.max_rudder_deflection_deg

    elevator_rad = deg2rad(elevator_deg)
    aileron_rad  = deg2rad(aileron_deg)
    rudder_rad   = deg2rad(rudder_deg)

    # --- Constants (scalar linear derivatives) ---
    # CL_0 default is set so that a 1500 kg aircraft with S ≈ 16 m² can fly
    # level at ~70 m/s at sea level.  Aircraft YAMLs that target a very
    # different weight/speed envelope should set CL_0 explicitly.
    CL_0       = linear_aero_constant(aircraft_data, :CL_0,       0.35)
    CL_alpha   = linear_aero_constant(aircraft_data, :CL_alpha,   5.50)   # per rad
    CL_q_hat   = linear_aero_constant(aircraft_data, :CL_q_hat,   4.0)
    CL_delta_e = linear_aero_constant(aircraft_data, :CL_delta_e, 0.40)   # per rad
    CD_0       = linear_aero_constant(aircraft_data, :CD0,        0.025)
    Oswald     = linear_aero_constant(aircraft_data, :Oswald_factor, 0.80)
    AR         = linear_aero_constant(aircraft_data, :AR, max(b_ref*b_ref/max(S_ref,1e-6), 1.0))
    CY_beta    = linear_aero_constant(aircraft_data, :CY_beta,   -0.50)   # per rad
    CY_delta_r = linear_aero_constant(aircraft_data, :CY_delta_r, 0.15)   # per rad
    Cm_0       = linear_aero_constant(aircraft_data, :Cm0,        0.0)
    Cm_alpha   = linear_aero_constant(aircraft_data, :Cm_alpha,  -1.50)   # per rad (stable, nose-down restoring)
    Cm_q       = linear_aero_constant(aircraft_data, :Cm_q,     -18.0)
    Cm_delta_e = linear_aero_constant(aircraft_data, :Cm_delta_e,-2.50)   # per rad
    # Safety fallbacks: a YAML that leaves these at 0 (or extremely weak)
    # produces an aircraft that is either undamped, neutrally stable, or
    # feels like the elevator is tied in a knot.  Floor each derivative
    # at a conservative textbook value so the linear model remains the
    # "well-behaved, simple" fallback as advertised.
    #
    # Pitch damping Cm_q is floored to -25 (fighter-class).  Combined with
    # the quadratic rate augmentation below, this keeps full-stick pitch
    # rates bounded to physical values at all speeds.
    Cl_beta    = linear_aero_constant(aircraft_data, :Cl_beta,   -0.10)   # per rad
    Cl_p       = linear_aero_constant(aircraft_data, :Cl_p,      -0.50)
    Cl_r       = linear_aero_constant(aircraft_data, :Cl_r,       0.10)
    Cl_delta_a = linear_aero_constant(aircraft_data, :Cl_delta_a, 0.20)   # per rad
    Cl_delta_r = linear_aero_constant(aircraft_data, :Cl_delta_r, 0.01)   # per rad
    Cn_beta    = linear_aero_constant(aircraft_data, :Cn_beta,    0.12)   # per rad (weathercock)
    Cn_p       = linear_aero_constant(aircraft_data, :Cn_p,      -0.05)
    Cn_r       = linear_aero_constant(aircraft_data, :Cn_r,      -0.20)
    Cn_delta_a = linear_aero_constant(aircraft_data, :Cn_delta_a,-0.01)   # adverse yaw, per rad
    Cn_delta_r = linear_aero_constant(aircraft_data, :Cn_delta_r, 0.10)   # per rad (+ for right-rudder → nose-right)

    # Safety floors on stability, damping, and control derivatives.  An
    # aircraft whose YAML leaves these at 0 or an extremely weak value has
    # either no static stability (Cm_α, Cn_β, Cl_β), no rate damping (Cl_p,
    # Cm_q, Cn_r), or weak control authority (Cm_δe) — which the pilot
    # experiences as an uncontrollable aircraft that diverges, oscillates,
    # or refuses to respond.  Each floor here is a conservative textbook
    # value applied ONLY when the YAML is weaker than it, and a one-time
    # log line is emitted below so the user can see exactly which of the
    # current aircraft's derivatives are being driven by the YAML vs by
    # the floor.  To bypass a floor entirely, set the YAML value past it
    # (e.g. `Cm_q: -15.1` instead of `-14`).
    floors_applied = Tuple{Symbol,Float64,Float64}[]   # (name, yaml_value, floor_value)
    _apply_floor! = (name, value, should_floor, floored_value) -> begin
        if should_floor
            push!(floors_applied, (name, value, floored_value))
            return floored_value
        end
        return value
    end

    Cm_alpha   = _apply_floor!(:Cm_alpha,   Cm_alpha,   Cm_alpha   >= -0.80, -1.80)
    Cm_q       = _apply_floor!(:Cm_q,       Cm_q,       Cm_q       >= -15.0, -25.0)
    Cm_delta_e = _apply_floor!(:Cm_delta_e, Cm_delta_e, Cm_delta_e >= -0.80, -1.20)
    Cn_beta    = _apply_floor!(:Cn_beta,    Cn_beta,    Cn_beta    <=  0.06,  0.15)
    Cn_r       = _apply_floor!(:Cn_r,       Cn_r,       Cn_r       >= -0.40, -0.80)
    Cl_beta    = _apply_floor!(:Cl_beta,    Cl_beta,    Cl_beta    >= -0.05, -0.12)
    Cl_p       = _apply_floor!(:Cl_p,       Cl_p,       Cl_p       >= -0.50, -0.80)

    if !_LINEAR_AERO_FLOOR_REPORTED[]
        _LINEAR_AERO_FLOOR_REPORTED[] = true
        if isempty(floors_applied)
            @info "linear aero: all stability/damping/control derivatives come from YAML — no safety floors applied"
        else
            floored_names = join([string(f[1]) for f in floors_applied], ", ")
            @info "linear aero: safety floors applied — these YAML values were too weak and got clobbered" floored=floored_names
            for (name, yaml_val, floor_val) in floors_applied
                @info "    $(name): yaml=$(round(yaml_val, digits=3)) → floor=$(round(floor_val, digits=3))"
            end
        end
    end

    alpha_stall_pos  = linear_aero_constant(aircraft_data, :alpha_stall_positive, 15.0)
    alpha_stall_neg  = linear_aero_constant(aircraft_data, :alpha_stall_negative, -15.0)
    beta_stall_deg   = linear_aero_constant(aircraft_data, :beta_stall, 20.0)
    alpha_knee_deg   = linear_aero_constant(aircraft_data, :alpha_stall_knee_deg, 3.0)
    beta_knee_deg    = linear_aero_constant(aircraft_data, :beta_stall_knee_deg,  5.0)

    induced_drag_factor = max(pi * AR * Oswald, 1.0e-6)

    # --- Soft-saturated α and β for the attached-flow linear terms ---
    # These capped angles feed every contribution that physically comes
    # from attached flow over the wing/tail (CL_α, CY_β, Cm_α, Cl_β, Cn_β).
    # Beyond the stall envelope those coefficients stop growing linearly
    # — the physics that generates them (a fully attached boundary layer)
    # no longer exists.  Damping (Cl_p, Cm_q, Cn_r), control-surface
    # deflections, and the post-stall flat-plate CL/CD model continue to
    # use the raw α/β because they remain physically active in stall.
    alpha_rad_sat = _soft_saturate(
        alpha_rad,
        deg2rad(alpha_stall_neg),   # lower limit (negative)
        deg2rad(alpha_stall_pos),   # upper limit (positive)
        deg2rad(alpha_knee_deg),
    )
    beta_rad_sat = _soft_saturate(
        beta_rad,
        -deg2rad(abs(beta_stall_deg)),
         deg2rad(abs(beta_stall_deg)),
        deg2rad(beta_knee_deg),
    )

    # --- Pre-stall (linear) coefficients ---
    # α/β appear as α_sat/β_sat everywhere they represent attached-flow
    # stability derivatives; damping and control terms keep raw rates and
    # deflections because they are rate-driven / surface-driven, not α-
    # driven, and they physically continue to act in post-stall flow.
    #
    # Per the empirical no-flip convention (see header), the sim rates
    # p_sim, q_sim, r_sim are used directly as the stability-derivative
    # rates (p_std, q_std, r_std above are identity-assigned).
    CL_pre = CL_0 + CL_alpha * alpha_rad_sat + CL_q_hat * q_hat + CL_delta_e * elevator_rad
    CD_pre = CD_0 + (CL_pre * CL_pre) / induced_drag_factor
    CY_pre = CY_beta * beta_rad_sat + CY_delta_r * rudder_rad
    Cm_pre = Cm_0 + Cm_alpha * alpha_rad_sat + Cm_q * damp_aug_q * q_hat + Cm_delta_e * elevator_rad
    # Use the exported Cl_beta sign directly so the linearized model follows
    # the same small-angle dihedral behaviour as the tabular database.
    Cl_pre = Cl_beta * beta_rad_sat +
             Cl_p * damp_aug_p * p_hat +
             Cl_r * r_hat +
             Cl_delta_a * aileron_rad +
             Cl_delta_r * rudder_rad
    Cn_pre = Cn_beta * beta_rad_sat +
             Cn_p * p_hat +
             Cn_r * damp_aug_r * r_hat +
             Cn_delta_a * aileron_rad +
             Cn_delta_r * rudder_rad

    # --- Post-stall (flat plate + restoring Cm) coefficients ---
    sin_alpha = sin(alpha_rad)
    sin_2alpha = sin(2.0 * alpha_rad)

    CL_post = _LINEAR_CL_POST_SCALE * sin_2alpha
    CD_post = _LINEAR_CD_POST_FLOOR + (_LINEAR_CD_POST_PEAK - _LINEAR_CD_POST_FLOOR) * (sin_alpha * sin_alpha)
    # Sideforce in post-stall behaves much like pre-stall but attenuated.
    CY_post = 0.5 * CY_pre
    # Derive the post-stall Cm amplitude so that d(Cm_post)/dα at α=0
    # matches Cm_alpha exactly (continuity of pitch stiffness across the
    # stall boundary).  d/dα [−K·sin(2α)] = −2K, which we want to equal
    # Cm_alpha, hence K = −Cm_alpha/2.  Floor to 0.4 so very weak
    # databases still get some restoring in the post-stall region.
    cm_post_scale = max(-Cm_alpha / 2.0, 0.40)
    Cm_post_stability = -cm_post_scale * sin_2alpha + Cm_delta_e * elevator_rad + Cm_q * damp_aug_q * q_hat
    Cl_post = Cl_delta_a * aileron_rad + Cl_p * damp_aug_p * p_hat          # only control and damping remain
    Cn_post = Cn_delta_r * rudder_rad + Cn_r * damp_aug_r * r_hat

    stall_blend = _linear_stall_blend_weight(alpha_deg, alpha_stall_pos, alpha_stall_neg)

    CL_total = (1.0 - stall_blend) * CL_pre + stall_blend * CL_post
    CD_total = (1.0 - stall_blend) * CD_pre + stall_blend * CD_post
    CS_total = (1.0 - stall_blend) * CY_pre + stall_blend * CY_post
    Cl_total = (1.0 - stall_blend) * Cl_pre + stall_blend * Cl_post
    Cm_total = (1.0 - stall_blend) * Cm_pre + stall_blend * Cm_post_stability
    Cn_total = (1.0 - stall_blend) * Cn_pre + stall_blend * Cn_post

    # The linearized derivatives are generated about the model-creation CG.
    # Re-reference the total moments to the CURRENT aircraft CG so users can
    # move x_CoG in the YAML and immediately see the static-margin change.
    cg_reference = [
        linear_aero_constant(aircraft_data, :x_aero_reference_CoG, linear_aero_constant(aircraft_data, :x_CoG, 0.0)),
        linear_aero_constant(aircraft_data, :y_aero_reference_CoG, linear_aero_constant(aircraft_data, :y_CoG, 0.0)),
        linear_aero_constant(aircraft_data, :z_aero_reference_CoG, linear_aero_constant(aircraft_data, :z_CoG, 0.0)),
    ]
    cg_current = [
        linear_aero_constant(aircraft_data, :x_CoG, cg_reference[1]),
        linear_aero_constant(aircraft_data, :y_CoG, cg_reference[2]),
        linear_aero_constant(aircraft_data, :z_CoG, cg_reference[3]),
    ]
    CM_at_current_cg = _translate_component_moment_coefficients(
        [CD_total, CS_total, CL_total],
        [Cl_total, Cm_total, Cn_total],
        cg_current .- cg_reference,
        c_ref,
        b_ref
    )
    Cl_total = CM_at_current_cg[1]
    Cm_total = CM_at_current_cg[2]
    Cn_total = CM_at_current_cg[3]

    # --- Dimensional force in wind axes, then to body ---
    D_force = q_inf * S_ref * CD_total
    Y_force = q_inf * S_ref * CS_total
    L_force = q_inf * S_ref * CL_total

    Fx_std, Fy_std, Fz_std = transform_aerodynamic_forces_from_wind_to_body_frame(
        D_force, Y_force, L_force, alpha_rad, beta_rad
    )
    aero_force_body_sim_N = [Fx_std, -Fz_std, -Fy_std]

    # --- Dimensional moments in standard body frame ---
    L_roll_std  = q_inf * S_ref * b_ref * Cl_total
    M_pitch_std = q_inf * S_ref * c_ref * Cm_total
    N_yaw_std   = q_inf * S_ref * b_ref * Cn_total

    # EMPIRICAL moment-slot convention (verified by user test 2026-04-11):
    # the sim expects moment components in [roll, yaw, pitch] order with no
    # sign flip. Theoretical basis-transform arguments suggest slots 2 and 3
    # should flip (because sim y_up = −std z_down and sim z_left = −std
    # y_right), but doing so empirically reverses the pitch and yaw control
    # response and destabilises pitch. Trust the integrator's internal
    # convention — it already matches the no-flip interpretation.
    aero_moment_body_sim_Nm = [L_roll_std, N_yaw_std, M_pitch_std]

    if LINEAR_AERO_DEBUG
        _LINEAR_AERO_DEBUG_COUNTER[] += 1
        if _LINEAR_AERO_DEBUG_COUNTER[] % LINEAR_AERO_DEBUG_EVERY_N_FRAMES == 0
            @info "linear_aero" α_deg=round(rad2deg(alpha_rad), digits=2) β_deg=round(rad2deg(beta_rad), digits=2) pitch=round(pitch_demand, digits=3) roll=round(roll_demand, digits=3) yaw=round(yaw_demand, digits=3) δe_deg=round(elevator_deg, digits=2) δa_deg=round(aileron_deg, digits=2) δr_deg=round(rudder_deg, digits=2) CL=round(CL_total, digits=3) CD=round(CD_total, digits=3) Cl=round(Cl_total, digits=4) Cm=round(Cm_total, digits=4) Cn=round(Cn_total, digits=4) Lsim=round(aero_moment_body_sim_Nm[1], digits=1) Nsim=round(aero_moment_body_sim_Nm[2], digits=1) Msim=round(aero_moment_body_sim_Nm[3], digits=1) p_sim=round(p_sim, digits=3) r_sim=round(r_sim, digits=3) q_sim=round(q_sim, digits=3)
        end
    end

    return (
        aero_force_body_sim_N   = aero_force_body_sim_N,
        aero_moment_body_sim_Nm = aero_moment_body_sim_Nm,
        CL_total = CL_total, CD_total = CD_total, CS_total = CS_total,
        Cl_total = Cl_total, Cm_total = Cm_total, Cn_total = Cn_total,
        elevator_deg = elevator_deg, aileron_deg = aileron_deg, rudder_deg = rudder_deg,
        stall_blend_weight = stall_blend,
    )
end
