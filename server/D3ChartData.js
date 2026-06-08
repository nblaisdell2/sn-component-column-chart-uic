/**
 * D3ChartData — Script Include (global, accessible from all application scopes)
 * ---------------------------------------------------------------------------
 * Reusable transform that turns platform data into the JSON shape expected by
 * the x-1295779-column-chart-uic component's "Data · Series data" property:
 *
 *   [ { name: "<series>", color?: "#hex", data: [ { label, value }, ... ] }, ... ]
 *
 * Two entry points:
 *   - fromAggregate(cfg)  : server-side GlideAggregate (count/sum/avg/min/max),
 *                           grouped by a category field, optionally split into
 *                           multiple series by a second field.
 *   - fromRows(rows, cfg) : reshape an array of already-fetched plain objects
 *                           (e.g. a "Look up records" data-resource output).
 *
 * Used by the "D3 Column Chart Data" Transform data resource and may also be
 * called from client scripts via GlideAjax (wrap in an AbstractAjaxProcessor).
 *
 * Written in ES5 for broad scoped/global compatibility.
 */
var D3ChartData = Class.create();
D3ChartData.prototype = {

	initialize: function () {},

	/**
	 * Aggregate a table into series JSON.
	 * cfg: {
	 *   table, filter, categoryField, seriesField?, metric (count|sum|avg|min|max),
	 *   valueField (required if metric!=count), seriesName?, useDisplayValue (default true),
	 *   colors (array | {seriesName:color} | JSON string), maxCategories?, sort?
	 * }
	 */
	fromAggregate: function (cfg) {
		cfg = cfg || {};
		var table = this._str(cfg.table);
		var categoryField = this._str(cfg.categoryField);
		if (!table || !categoryField) {
			return [];
		}
		var seriesField = this._str(cfg.seriesField);
		var metric = (this._str(cfg.metric) || 'count').toLowerCase();
		var valueField = this._str(cfg.valueField);
		var useDisplay = cfg.useDisplayValue !== false && cfg.useDisplayValue !== 'false';
		if (metric !== 'count' && !valueField) {
			return []; // sum/avg/min/max need a numeric field
		}

		var ga = new GlideAggregate(table);
		if (this._str(cfg.filter)) {
			ga.addEncodedQuery(cfg.filter);
		}
		ga.groupBy(categoryField);
		if (seriesField) {
			ga.groupBy(seriesField);
		}
		if (metric === 'count') {
			ga.addAggregate('COUNT');
		} else {
			ga.addAggregate(metric.toUpperCase(), valueField);
		}
		ga.query();

		var defaultSeriesName = this._str(cfg.seriesName) || this._metricLabel(metric, valueField);
		var rows = [];
		while (ga.next()) {
			var catLabel = useDisplay ? ga.getDisplayValue(categoryField) : ga.getValue(categoryField);
			var seriesLabel = defaultSeriesName;
			if (seriesField) {
				seriesLabel = useDisplay ? ga.getDisplayValue(seriesField) : ga.getValue(seriesField);
			}
			var value;
			if (metric === 'count') {
				value = parseInt(ga.getAggregate('COUNT'), 10);
			} else {
				value = parseFloat(ga.getAggregate(metric.toUpperCase(), valueField));
			}
			rows.push({
				catLabel: this._blank(catLabel),
				seriesLabel: this._blank(seriesLabel) === '(empty)' ? 'Value' : this._blank(seriesLabel),
				value: isNaN(value) ? 0 : value
			});
		}
		// rows from GlideAggregate are already unique per (category, series)
		return this._buildSeries(rows, cfg, null);
	},

	/**
	 * Reshape an array of plain objects into series JSON.
	 * rows: array of objects (values may be primitives, GlideElement, or {value, displayValue}).
	 * cfg: { categoryField, seriesField?, valueField, seriesName?, metric? (to combine
	 *        duplicate category/series pairs: sum|avg|min|max|count, default sum), colors }
	 */
	fromRows: function (rows, cfg) {
		cfg = cfg || {};
		rows = rows || [];
		var categoryField = this._str(cfg.categoryField);
		var seriesField = this._str(cfg.seriesField);
		var valueField = this._str(cfg.valueField);
		var defaultSeriesName = this._str(cfg.seriesName) || 'Value';

		var collected = [];
		for (var i = 0; i < rows.length; i++) {
			var r = rows[i] || {};
			var catLabel = this._readField(r, categoryField);
			var seriesLabel = seriesField ? this._readField(r, seriesField) : defaultSeriesName;
			var value = parseFloat(this._readField(r, valueField));
			collected.push({
				catLabel: this._blank(catLabel),
				seriesLabel: this._blank(seriesLabel) === '(empty)' ? 'Value' : this._blank(seriesLabel),
				value: isNaN(value) ? 0 : value
			});
		}
		return this._buildSeries(collected, cfg, (this._str(cfg.metric) || 'sum').toLowerCase());
	},

	/**
	 * Build series JSON from Performance/Platform Analytics indicator scores (pa_scores).
	 * cfg.mode:
	 *   'trend'     (default) — columns = collection dates, one series per indicator
	 *   'latest'    — one column per indicator (most recent score), single series
	 *   'breakdown' — one indicator sliced by a breakdown, one column per element (latest period)
	 * cfg: {
	 *   mode, indicators (csv of sys_ids or names) | indicator (single), breakdown (sys_id),
	 *   source ('auto' default | 'scores' | 'scorecard'), step (scorecard period granularity),
	 *   lastPeriods (default 12), from, to, seriesName, colors, maxCategories, sort,
	 *   dateField/valueField/breakdownField/elementField (advanced pa_scores overrides)
	 * }
	 * source: 'scores' reads collected scores from pa_scores (GlideRecord); 'scorecard' computes
	 * Formula/realtime indicators via the PAScorecard engine; 'auto' uses pa_scores and falls back
	 * to the scorecard engine when an indicator has no collected scores.
	 */
	fromIndicator: function (cfg) {
		cfg = cfg || {};
		var mode = (this._str(cfg.mode) || 'trend').toLowerCase();
		if (mode === 'latest') { return this._indicatorLatest(cfg); }
		if (mode === 'breakdown') { return this._indicatorBreakdown(cfg); }
		return this._indicatorTrend(cfg);
	},

	// ----- Performance Analytics internals --------------------------------

	_paFields: function (cfg) {
		return {
			date: this._str(cfg.dateField) || 'date',
			value: this._str(cfg.valueField) || 'value',
			breakdown: this._str(cfg.breakdownField) || 'breakdown',
			element: this._str(cfg.elementField) || 'element'
		};
	},

	/** Resolve a sys_id or indicator name into { sysId, name }. */
	_resolveIndicator: function (idOrName) {
		idOrName = this._str(idOrName);
		if (!idOrName) { return null; }
		var gr = new GlideRecord('pa_indicators');
		if (/^[0-9a-f]{32}$/i.test(idOrName)) {
			if (gr.get(idOrName)) { return { sysId: gr.getUniqueValue(), name: gr.getValue('name') }; }
			return { sysId: idOrName, name: idOrName };
		}
		gr.addQuery('name', idOrName);
		gr.setLimit(1);
		gr.query();
		if (gr.next()) { return { sysId: gr.getUniqueValue(), name: gr.getValue('name') }; }
		return null;
	},

	/** Resolve a csv/array of indicator sys_ids or names into a list of { sysId, name }. */
	_resolveIndicatorList: function (val) {
		var out = [];
		if (!val) { return out; }
		var arr = (Object.prototype.toString.call(val) === '[object Array]') ? val : ('' + val).split(',');
		for (var i = 0; i < arr.length; i++) {
			var token = this._str(arr[i]);
			if (!token) { continue; }
			var r = this._resolveIndicator(token);
			if (r) { out.push(r); }
		}
		return out;
	},

	/** Resolve cfg.source to 'auto' | 'scores' | 'scorecard'. */
	_source: function (cfg) {
		var s = (this._str(cfg.source) || 'auto').toLowerCase();
		return (s === 'scores' || s === 'scorecard') ? s : 'auto';
	},

	/** Numeric score from a PAScorecard cursor (prefer getScore, fall back to getValue). */
	_scNum: function (sc) {
		var v;
		try { v = sc.getScore(); } catch (e) { v = undefined; }
		if (v === undefined || v === null || v === '' || isNaN(parseFloat(v))) {
			try { v = sc.getValue(); } catch (e2) { v = undefined; }
		}
		v = parseFloat(v);
		return isNaN(v) ? 0 : v;
	},

	/** Period label (date part) from a PAScorecard cursor. */
	_scDate: function (sc) {
		var d = '';
		try { d = sc.getStart(); } catch (e) { d = ''; }
		d = (d === null || d === undefined) ? '' : ('' + d);
		if (d.indexOf(' ') > -1) { d = d.split(' ')[0]; }
		return d || '(period)';
	},

	_indicatorTrend: function (cfg) {
		var inds = this._resolveIndicatorList(cfg.indicators || cfg.indicator);
		var rows = [];
		for (var i = 0; i < inds.length; i++) {
			var ind = inds[i];
			var pts = this._trendRows(ind, cfg);
			for (var t = 0; t < pts.length; t++) {
				rows.push({ catLabel: this._blank(pts[t].label), seriesLabel: ind.name, value: pts[t].value });
			}
		}
		return this._buildSeries(rows, cfg, null);
	},

	/** [{label,value}] for one indicator's trend, honoring cfg.source. */
	_trendRows: function (ind, cfg) {
		var src = this._source(cfg);
		var pts = [];
		if (src !== 'scorecard') { pts = this._scoresTrend(ind, cfg); }
		if (src === 'scorecard' || (src === 'auto' && !pts.length)) { pts = this._scorecardTrend(ind, cfg); }
		return pts;
	},

	_scoresTrend: function (ind, cfg) {
		var f = this._paFields(cfg);
		var lastPeriods = parseInt(cfg.lastPeriods, 10);
		if (isNaN(lastPeriods) || lastPeriods <= 0) { lastPeriods = 12; }
		var from = this._str(cfg.from);
		var to = this._str(cfg.to);
		var gr = new GlideRecord('pa_scores');
		gr.addQuery('indicator', ind.sysId);
		gr.addNullQuery(f.breakdown); // overall score (no breakdown)
		if (from) { gr.addQuery(f.date, '>=', from); }
		if (to) { gr.addQuery(f.date, '<=', to); }
		if (from || to) { gr.orderBy(f.date); } else { gr.orderByDesc(f.date); gr.setLimit(lastPeriods); }
		gr.query();
		var temp = [];
		while (gr.next()) {
			var v = parseFloat(gr.getValue(f.value));
			temp.push({ label: gr.getDisplayValue(f.date), value: isNaN(v) ? 0 : v });
		}
		if (!(from || to)) { temp.reverse(); } // restore chronological order after desc+limit
		return temp;
	},

	/** Formula/realtime indicators: compute via the PAScorecard engine. */
	_scorecardTrend: function (ind, cfg) {
		var out = [];
		var from = this._str(cfg.from);
		var to = this._str(cfg.to);
		try {
			var sc = new PAScorecard();
			sc.addParam('uuid', ind.sysId);
			sc.addParam('display_value', 'true');
			var step = this._str(cfg.step);
			if (step) { sc.addParam('step', step); }
			if (from) { sc.addParam('from', from); }
			if (to) { sc.addParam('to', to); }
			sc.query();
			while (sc.hasNext()) {
				sc.next();
				out.push({ label: this._scDate(sc), value: this._scNum(sc) });
			}
		} catch (e) {
			return [];
		}
		var lastPeriods = parseInt(cfg.lastPeriods, 10);
		if (!from && !to && !isNaN(lastPeriods) && lastPeriods > 0 && out.length > lastPeriods) {
			out = out.slice(out.length - lastPeriods);
		}
		return out;
	},

	_indicatorLatest: function (cfg) {
		var inds = this._resolveIndicatorList(cfg.indicators || cfg.indicator);
		var seriesName = this._str(cfg.seriesName) || 'Latest';
		var rows = [];
		for (var i = 0; i < inds.length; i++) {
			var ind = inds[i];
			rows.push({ catLabel: ind.name, seriesLabel: seriesName, value: this._latestValue(ind, cfg) });
		}
		return this._buildSeries(rows, cfg, null);
	},

	_latestValue: function (ind, cfg) {
		var src = this._source(cfg);
		var v = null;
		if (src !== 'scorecard') { v = this._scoresLatest(ind, cfg); }
		if (src === 'scorecard' || (src === 'auto' && v === null)) { v = this._scorecardLatest(ind, cfg); }
		return (v === null || isNaN(v)) ? 0 : v;
	},

	_scoresLatest: function (ind, cfg) {
		var f = this._paFields(cfg);
		var gr = new GlideRecord('pa_scores');
		gr.addQuery('indicator', ind.sysId);
		gr.addNullQuery(f.breakdown);
		gr.orderByDesc(f.date);
		gr.setLimit(1);
		gr.query();
		if (gr.next()) { var v = parseFloat(gr.getValue(f.value)); return isNaN(v) ? 0 : v; }
		return null; // null lets 'auto' fall back to the scorecard engine
	},

	_scorecardLatest: function (ind, cfg) {
		var pts = this._scorecardTrend(ind, cfg);
		if (!pts.length) { return null; }
		return pts[pts.length - 1].value; // most recent computed period
	},

	_indicatorBreakdown: function (cfg) {
		var ind = this._resolveIndicator(cfg.indicator || cfg.indicators);
		var breakdown = this._str(cfg.breakdown);
		if (!ind || !breakdown) { return []; }
		var seriesName = this._str(cfg.seriesName) || ind.name;
		var src = this._source(cfg);
		var pts = [];
		if (src !== 'scorecard') { pts = this._scoresBreakdown(ind, breakdown, cfg); }
		if (src === 'scorecard' || (src === 'auto' && !pts.length)) { pts = this._scorecardBreakdown(ind, breakdown, cfg); }
		var rows = [];
		for (var i = 0; i < pts.length; i++) {
			rows.push({ catLabel: this._blank(pts[i].label), seriesLabel: seriesName, value: pts[i].value });
		}
		return this._buildSeries(rows, cfg, null);
	},

	_scoresBreakdown: function (ind, breakdown, cfg) {
		var f = this._paFields(cfg);
		// latest collected date for this indicator + breakdown
		var latest = '';
		var g1 = new GlideRecord('pa_scores');
		g1.addQuery('indicator', ind.sysId);
		g1.addQuery(f.breakdown, breakdown);
		g1.orderByDesc(f.date);
		g1.setLimit(1);
		g1.query();
		if (g1.next()) { latest = g1.getValue(f.date); }
		if (!latest) { return []; }
		var out = [];
		var gr = new GlideRecord('pa_scores');
		gr.addQuery('indicator', ind.sysId);
		gr.addQuery(f.breakdown, breakdown);
		gr.addQuery(f.date, latest);
		gr.query();
		while (gr.next()) {
			var v = parseFloat(gr.getValue(f.value));
			out.push({ label: gr.getDisplayValue(f.element), value: isNaN(v) ? 0 : v });
		}
		return out;
	},

	_scorecardBreakdown: function (ind, breakdown, cfg) {
		var out = [];
		try {
			var sc = new PAScorecard();
			sc.addParam('uuid', ind.sysId);
			sc.addParam('breakdown', breakdown);
			sc.addParam('display_value', 'true');
			var ef = this._str(cfg.elementsFilter);
			if (ef) { sc.addParam('elements_filter', ef); }
			sc.query();
			while (sc.hasNext()) {
				sc.next();
				var label = '';
				try { label = sc.getLabel(); } catch (e) { try { label = sc.getDisplayValue(); } catch (e2) { label = ''; } }
				out.push({ label: (label === null || label === undefined || label === '') ? '(element)' : ('' + label), value: this._scNum(sc) });
			}
		} catch (e3) {
			return [];
		}
		return out;
	},

	// ----- internals -------------------------------------------------------

	/**
	 * Build the ordered series array from flat rows {catLabel, seriesLabel, value}.
	 * dupMetric: how to combine duplicate (series,category) pairs (null = assume unique).
	 */
	_buildSeries: function (rows, cfg, dupMetric) {
		var categories = [];
		var catSeen = {};
		var seriesOrder = [];
		var seriesSeen = {};
		var cells = {};   // seriesLabel -> { catLabel -> value }
		var counts = {};  // seriesLabel -> { catLabel -> n }  (for avg)

		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			if (!catSeen[row.catLabel]) { catSeen[row.catLabel] = true; categories.push(row.catLabel); }
			if (!seriesSeen[row.seriesLabel]) {
				seriesSeen[row.seriesLabel] = true;
				seriesOrder.push(row.seriesLabel);
				cells[row.seriesLabel] = {};
				counts[row.seriesLabel] = {};
			}
			var bucket = cells[row.seriesLabel];
			var cnt = counts[row.seriesLabel];
			if (bucket[row.catLabel] === undefined) {
				bucket[row.catLabel] = row.value;
				cnt[row.catLabel] = 1;
			} else {
				var m = dupMetric || 'sum';
				if (m === 'min') bucket[row.catLabel] = Math.min(bucket[row.catLabel], row.value);
				else if (m === 'max') bucket[row.catLabel] = Math.max(bucket[row.catLabel], row.value);
				else bucket[row.catLabel] += row.value; // sum/avg/count
				cnt[row.catLabel]++;
			}
		}
		if (dupMetric === 'avg') {
			for (var s in cells) {
				for (var c in cells[s]) { cells[s][c] = cells[s][c] / counts[s][c]; }
			}
		}

		this._sortCategories(categories, cells, seriesOrder, cfg);
		var max = parseInt(cfg.maxCategories, 10);
		if (max && categories.length > max) {
			categories = this._topCategories(categories, cells, seriesOrder, max);
		}

		var parsedColors = this._parseColors(cfg.colors);
		var out = [];
		for (var k = 0; k < seriesOrder.length; k++) {
			var sLabel = seriesOrder[k];
			var data = [];
			for (var ci = 0; ci < categories.length; ci++) {
				var cl = categories[ci];
				var v = cells[sLabel][cl];
				data.push({ label: String(cl), value: v === undefined ? 0 : v });
			}
			var entry = { name: String(sLabel), data: data };
			var color = this._colorFor(parsedColors, sLabel, k);
			if (color) { entry.color = color; }
			out.push(entry);
		}
		return out;
	},

	_sortCategories: function (categories, cells, seriesOrder, cfg) {
		var sort = (this._str(cfg.sort) || '').toLowerCase();
		if (!sort || sort === 'none') { return; } // keep insertion order (good for time series)
		var byValue = sort.indexOf('value') > -1;
		var desc = sort.indexOf('desc') > -1;
		if (byValue) {
			var total = this._totals(categories, cells, seriesOrder);
			categories.sort(function (a, b) { return total[a] - total[b]; });
		} else {
			categories.sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
		}
		if (desc) { categories.reverse(); }
	},

	_topCategories: function (categories, cells, seriesOrder, n) {
		var total = this._totals(categories, cells, seriesOrder);
		var ranked = categories.slice();
		ranked.sort(function (a, b) { return total[b] - total[a]; });
		var keep = {};
		for (var i = 0; i < n && i < ranked.length; i++) { keep[ranked[i]] = true; }
		var result = [];
		for (var j = 0; j < categories.length; j++) {
			if (keep[categories[j]]) { result.push(categories[j]); }
		}
		return result;
	},

	_totals: function (categories, cells, seriesOrder) {
		var total = {};
		for (var ci = 0; ci < categories.length; ci++) {
			var c = categories[ci];
			var t = 0;
			for (var k = 0; k < seriesOrder.length; k++) {
				var v = cells[seriesOrder[k]][c];
				if (v) { t += v; }
			}
			total[c] = t;
		}
		return total;
	},

	_parseColors: function (colors) {
		if (!colors) { return null; }
		if (typeof colors === 'string') {
			var s = colors.replace(/^\s+|\s+$/g, '');
			if (!s) { return null; }
			try {
				colors = JSON.parse(s);
			} catch (e) {
				colors = s.split(',');
				for (var i = 0; i < colors.length; i++) {
					colors[i] = colors[i].replace(/^\s+|\s+$/g, '');
				}
			}
		}
		if (Object.prototype.toString.call(colors) === '[object Array]') {
			return { type: 'array', value: colors };
		}
		if (typeof colors === 'object') {
			return { type: 'map', value: colors };
		}
		return null;
	},

	_colorFor: function (parsed, label, index) {
		if (!parsed) { return null; }
		if (parsed.type === 'array') {
			if (!parsed.value.length) { return null; }
			return parsed.value[index % parsed.value.length];
		}
		if (parsed.type === 'map') {
			return parsed.value[label] || null;
		}
		return null;
	},

	_metricLabel: function (metric, valueField) {
		if (metric === 'count') { return 'Count'; }
		var nice = metric.charAt(0).toUpperCase() + metric.slice(1);
		return valueField ? (nice + ' of ' + valueField) : nice;
	},

	/** Read a field from a plain object / GlideRecord-ish / {value,displayValue}. */
	_readField: function (obj, field) {
		if (!field) { return ''; }
		var v = obj[field];
		if (v && typeof v === 'object') {
			if (typeof v.getDisplayValue === 'function') { return v.getDisplayValue(); }
			if (v.displayValue !== undefined) { return v.displayValue; }
			if (v.value !== undefined) { return v.value; }
		}
		return (v === undefined || v === null) ? '' : v;
	},

	_str: function (v) {
		return (v === undefined || v === null) ? '' : ('' + v).replace(/^\s+|\s+$/g, '');
	},

	_blank: function (v) {
		var s = (v === undefined || v === null) ? '' : ('' + v);
		return s === '' ? '(empty)' : s;
	},

	type: 'D3ChartData'
};
