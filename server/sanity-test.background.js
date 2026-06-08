/**
 * Sanity test for the D3ChartData Script Include.
 * Run in: System Definition > Scripts - Background (scope: Global).
 * Confirms the Script Include returns the series shape the chart expects.
 *
 * Expected: a JSON array, one entry per series, each with a `data` array of
 * { label, value } — e.g. one series per incident state, one point per priority.
 */
(function () {
	var d3data = new global.D3ChartData();

	// 1) Aggregate: incident COUNT by priority, split into a series per state.
	var multi = d3data.fromAggregate({
		table: 'incident',
		categoryField: 'priority',
		seriesField: 'state',
		metric: 'count',
		useDisplayValue: true,
		sort: 'label-asc'
	});
	gs.info('[D3ChartData] aggregate (priority x state):\n' + JSON.stringify(multi, null, 2));

	// 2) Aggregate: single series, top 5 categories by count.
	var single = d3data.fromAggregate({
		table: 'incident',
		categoryField: 'category',
		metric: 'count',
		seriesName: 'Incidents',
		maxCategories: 5,
		sort: 'value-desc',
		colors: '["#2E93fA"]'
	});
	gs.info('[D3ChartData] aggregate (top 5 categories):\n' + JSON.stringify(single, null, 2));

	// 3) fromRows: reshape already-fetched rows.
	var rows = [
		{ month: 'Jan', team: 'A', count: 4 },
		{ month: 'Jan', team: 'B', count: 6 },
		{ month: 'Feb', team: 'A', count: 5 },
		{ month: 'Feb', team: 'B', count: 3 }
	];
	var reshaped = d3data.fromRows(rows, {
		categoryField: 'month',
		seriesField: 'team',
		valueField: 'count'
	});
	gs.info('[D3ChartData] fromRows (month x team):\n' + JSON.stringify(reshaped, null, 2));
})();
