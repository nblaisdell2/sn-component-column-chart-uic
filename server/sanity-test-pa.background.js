/**
 * PA sanity + schema check for D3ChartData.fromIndicator.
 * Run in: System Definition > Scripts - Background (scope: Global).
 *
 * 1) Dumps the field names/values of a recent pa_scores row so you can confirm
 *    the date / value / breakdown / element column names match the defaults
 *    ('date','value','breakdown','element'). If yours differ, set the matching
 *    dateField/valueField/breakdownField/elementField inputs on the data resource.
 * 2) Exercises fromIndicator() for trend / latest / breakdown.
 *
 * EDIT these to real sys_ids (or indicator names) on your instance first:
 */
(function () {
	var INDICATORS = 'REPLACE_WITH_INDICATOR_SYS_ID_OR_NAME'; // e.g. 'a1b2...' or 'Number of open incidents'
	var INDICATORS_MULTI = INDICATORS;                         // add ',anotherSysId' to compare series
	var BREAKDOWN_INDICATOR = INDICATORS;                      // indicator for the breakdown test
	var BREAKDOWN = 'REPLACE_WITH_BREAKDOWN_SYS_ID';           // from pa_breakdowns
	var FORMULA_INDICATOR = 'REPLACE_WITH_FORMULA_INDICATOR_SYS_ID_OR_NAME'; // realtime/Formula indicator

	// --- 1) pa_scores schema dump -----------------------------------------
	var sc = new GlideRecord('pa_scores');
	sc.orderByDesc('sys_created_on');
	sc.setLimit(1);
	sc.query();
	if (sc.next()) {
		var lines = [];
		var fields = sc.getFields();
		for (var i = 0; i < fields.size(); i++) {
			var ge = fields.get(i);
			lines.push('  ' + ge.getName() + ' = ' + ge.getDisplayValue() + '  [raw: ' + ge.toString() + ']');
		}
		gs.info('[D3ChartData PA] sample pa_scores row fields:\n' + lines.join('\n'));
	} else {
		gs.warn('[D3ChartData PA] No rows in pa_scores — have your indicators been collected yet?');
	}

	// --- 2) fromIndicator output ------------------------------------------
	var d3 = new global.D3ChartData();

	gs.info('[D3ChartData PA] trend:\n' + JSON.stringify(
		d3.fromIndicator({ mode: 'trend', indicators: INDICATORS_MULTI, lastPeriods: 12 }), null, 2));

	gs.info('[D3ChartData PA] latest:\n' + JSON.stringify(
		d3.fromIndicator({ mode: 'latest', indicators: INDICATORS_MULTI }), null, 2));

	gs.info('[D3ChartData PA] breakdown:\n' + JSON.stringify(
		d3.fromIndicator({ mode: 'breakdown', indicator: BREAKDOWN_INDICATOR, breakdown: BREAKDOWN }), null, 2));

	// --- 3) PAScorecard engine probe (Formula / realtime indicators) ------
	// Confirms the scriptable scorecard API is available and shows what its cursor
	// returns, so we can verify the value/date extraction used by source:'scorecard'.
	var fi = d3._resolveIndicator(FORMULA_INDICATOR);
	if (!fi) {
		gs.warn('[D3ChartData PA] Could not resolve FORMULA_INDICATOR — set a real sys_id/name.');
	} else {
		try {
			var probe = new PAScorecard();
			probe.addParam('uuid', fi.sysId);
			probe.addParam('display_value', 'true');
			probe.query();
			gs.info('[D3ChartData PA] PAScorecard recordCount = ' + probe.getRecordCount());
			var n = 0;
			while (probe.hasNext() && n < 5) {
				probe.next(); n++;
				gs.info('  rec ' + n + ': start=' + probe.getStart() + ' end=' + probe.getEnd() +
					' score=' + probe.getScore() + ' value=' + probe.getValue() + ' label=' + probe.getLabel());
			}
		} catch (e) {
			gs.warn('[D3ChartData PA] PAScorecard probe failed (API unavailable?): ' + e);
		}

		gs.info('[D3ChartData PA] scorecard latest:\n' + JSON.stringify(
			d3.fromIndicator({ mode: 'latest', source: 'scorecard', indicators: FORMULA_INDICATOR }), null, 2));
		gs.info('[D3ChartData PA] scorecard trend:\n' + JSON.stringify(
			d3.fromIndicator({ mode: 'trend', source: 'scorecard', indicators: FORMULA_INDICATOR, lastPeriods: 12 }), null, 2));
	}
})();
