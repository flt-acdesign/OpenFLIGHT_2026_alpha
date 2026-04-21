/********************************************
 * FILE: validation.js
 * Pre-export validation and live status
 * for OpenFlight simulator compatibility
 ********************************************/

// ================================================================
// VALIDATION FUNCTION
// ================================================================

function validateForOpenFlight(aircraftData, v21Model) {
  var errors = [];
  var warnings = [];
  var gen = aircraftData.general || {};
  var sref = Number(gen.aircraft_reference_area_m2 || 0);

  // ---- Critical errors (blocking) ----
  if (!gen.mass_kg || gen.mass_kg <= 0)
    errors.push('Aircraft mass is required and must be positive');

  if (!(sref > 0))
    errors.push('Reference area (S_ref) is required and must be positive');

  if (!gen.aircraft_reference_span_m || gen.aircraft_reference_span_m <= 0)
    errors.push('Reference span (b_ref) is required and must be positive');

  if (!gen.aircraft_reference_mean_aerodynamic_chord_m || gen.aircraft_reference_mean_aerodynamic_chord_m <= 0)
    errors.push('Reference MAC (c_ref) is required and must be positive');

  if (!aircraftData.lifting_surfaces || aircraftData.lifting_surfaces.length === 0)
    errors.push('At least one lifting surface is required');

  if (!aircraftData.engines || aircraftData.engines.length === 0)
    errors.push('At least one engine is required');

  if (!v21Model)
    errors.push('Run analysis first before exporting');

  // ---- Role checks (warnings) ----
  var surfaces = aircraftData.lifting_surfaces || [];
  var hasWing = surfaces.some(function(s) {
    return s.role === 'wing' || /^(wing|main)/i.test(s.name);
  });
  if (!hasWing)
    warnings.push('No surface tagged as "wing" - wing aerodynamic center will use defaults');

  var hasHTail = surfaces.some(function(s) {
    return s.role === 'horizontal_stabilizer' || /^(h?tail|horizontal|elevator)/i.test(s.name);
  });
  if (!hasHTail)
    warnings.push('No horizontal stabilizer defined - tail CL model will use defaults');

  var hasVTail = surfaces.some(function(s) {
    return s.role === 'vertical_stabilizer' || /^(v?tail|vertical|fin|rudder)/i.test(s.name);
  });
  if (!hasVTail)
    warnings.push('No vertical stabilizer defined - tail CS model will use defaults');

  // ---- Inertia check ----
  var inertia = gen.inertia || {};
  var pm = inertia.principal_moments_kgm2 || {};
  if (!pm.Ixx_p || !pm.Iyy_p || !pm.Izz_p)
    warnings.push('Inertia moments not fully defined - using defaults');

  // ---- Engine thrust check ----
  var engines = aircraftData.engines || [];
  if (engines.length > 0) {
    var eng0 = engines[0];
    if (!eng0.max_thrust_n && (!eng0.thrust_scale || eng0.thrust_scale <= 0))
      warnings.push('Engine max thrust not defined - export will use default value');
  }

  // ---- CoG check ----
  var cog = gen.aircraft_CoG_coords_xyz_m || [0, 0, 0];
  if (cog[0] === 0 && cog[1] === 0 && cog[2] === 0)
    warnings.push('Center of gravity at origin (0,0,0) - please verify');

  return {
    errors: errors,
    warnings: warnings,
    valid: errors.length === 0
  };
}

// ================================================================
// LIVE VALIDATION STATUS INDICATOR
// ================================================================

function updateValidationStatus() {
  var indicator = document.getElementById('validationIndicator');
  if (!indicator) return;

  var ad = window.aircraftData;
  var gen = ad.general || {};
  var sref = Number(gen.aircraft_reference_area_m2 || 0);
  var criticalOk = true;
  var warningCount = 0;

  // Check critical fields
  if (!gen.mass_kg || gen.mass_kg <= 0) criticalOk = false;
  if (!(sref > 0)) criticalOk = false;
  if (!ad.lifting_surfaces || ad.lifting_surfaces.length === 0) criticalOk = false;
  if (!ad.engines || ad.engines.length === 0) criticalOk = false;

  // Count warnings
  var surfaces = ad.lifting_surfaces || [];
  if (!surfaces.some(function(s) { return s.role === 'wing' || /^wing/i.test(s.name); })) warningCount++;
  if (!surfaces.some(function(s) { return s.role === 'horizontal_stabilizer' || /^h?tail/i.test(s.name); })) warningCount++;

  // Update indicator
  if (!criticalOk) {
    indicator.className = 'validation-indicator validation-error';
    indicator.title = 'Missing required fields (mass, reference area, surfaces, or engine)';
    indicator.innerHTML = '<i class="fas fa-times-circle"></i>';
  } else if (warningCount > 0) {
    indicator.className = 'validation-indicator validation-warning';
    indicator.title = warningCount + ' optional field(s) using defaults';
    indicator.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
  } else {
    indicator.className = 'validation-indicator validation-ok';
    indicator.title = 'All fields configured for OpenFlight export';
    indicator.innerHTML = '<i class="fas fa-check-circle"></i>';
  }
}

// ================================================================
// SHOW VALIDATION DIALOG BEFORE EXPORT
// ================================================================

function showValidationAndExport() {
  var result = validateForOpenFlight(window.aircraftData, window.aeroModel);

  if (result.errors.length > 0) {
    var msg = 'Cannot export - please fix these issues:\n\n';
    result.errors.forEach(function(e) { msg += '  - ' + e + '\n'; });
    if (result.warnings.length > 0) {
      msg += '\nAdditional warnings:\n';
      result.warnings.forEach(function(w) { msg += '  - ' + w + '\n'; });
    }
    alert(msg);
    return;
  }

  if (result.warnings.length > 0) {
    var wmsg = 'Export will proceed with defaults for these items:\n\n';
    result.warnings.forEach(function(w) { wmsg += '  - ' + w + '\n'; });
    wmsg += '\nContinue with export?';
    if (!confirm(wmsg)) return;
  }

  // Export BOTH tabular and linearized YAML files (v2.1 schema format).
  // Same logic as the YAML export button in results-panel.js.
  var name = (window.aircraftData.general.aircraft_name || 'aircraft').replace(/\s+/g, '_');

  var tabularYaml = customYamlDump(window.aeroModel);
  saveViaServer(tabularYaml, name + '.tabular.aero_prop.yaml');

  if (typeof buildLinearizedModel === 'function' && typeof window.addPendingExtraFile === 'function') {
    var linModel = buildLinearizedModel(window.aeroModel);
    var linYaml = customYamlDump(linModel);
    window.addPendingExtraFile(name + '.linearized.aero_prop.yaml', linYaml);
  }
}

// Attach validation updates to data changes
(function setupValidationListeners() {
  // Run validation update after any render cycle
  var origRender = window.renderAircraft;
  if (typeof origRender === 'function') {
    window.renderAircraft = function() {
      origRender.apply(this, arguments);
      updateValidationStatus();
    };
  }

  // Also update on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(updateValidationStatus, 500);
  });
})();
