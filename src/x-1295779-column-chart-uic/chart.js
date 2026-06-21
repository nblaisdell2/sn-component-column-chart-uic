/**
 * D3 column-chart renderer.
 *
 * `drawChart` fully (re)renders the chart into `container` on every call. It owns
 * the SVG subtree imperatively while the Seismic/snabbdom view only provides the
 * stable host container. Re-rendering on each property change keeps the
 * look-and-feel fully driven by the UI Builder property panel.
 *
 * We import the specific d3 functions we use as NAMED imports (rather than
 * `import * as d3`): the ServiceNow production build tree-shakes a namespace
 * object that's passed around, which would strip methods like `select`.
 *
 * dispatch(actionName, payload) emits the custom actions declared in now-ui.json
 * (CHART_CLICKED / COLUMN_CLICKED / COLUMN_HOVERED) so page authors can hook
 * them as event handlers in UI Builder.
 */
import { select } from 'd3-selection';
import { scaleBand, scaleLinear, scaleLog, scaleSqrt } from 'd3-scale';
import {
	schemeCategory10, schemeTableau10, schemeSet2, schemeSet3,
	schemePaired, schemeDark2, schemePastel1, schemeAccent
} from 'd3-scale-chromatic';
import { axisBottom, axisLeft } from 'd3-axis';
import { format } from 'd3-format';
import { color } from 'd3-color';
import {
	easeLinear, easeCubicOut, easeCubicInOut, easeQuadOut,
	easeExpOut, easeBackOut, easeBounceOut, easeElasticOut
} from 'd3-ease';

// Named categorical schemes selectable via the `colorScheme` property. Each is a
// plain array of CSS colors (imported by name so the prod build tree-shakes cleanly).
const COLOR_SCHEMES = {
	category10: schemeCategory10,
	tableau10: schemeTableau10,
	set2: schemeSet2,
	set3: schemeSet3,
	paired: schemePaired,
	dark2: schemeDark2,
	pastel1: schemePastel1,
	accent: schemeAccent
};

// Easing curves selectable via the `animationEasing` property (named imports so the
// prod build tree-shakes the unused ones).
const EASINGS = {
	linear: easeLinear,
	cubicOut: easeCubicOut,
	cubicInOut: easeCubicInOut,
	quadOut: easeQuadOut,
	expOut: easeExpOut,
	backOut: easeBackOut,
	bounceOut: easeBounceOut,
	elasticOut: easeElasticOut
};

const num = (v, fallback) => {
	const n = typeof v === 'string' ? parseFloat(v) : v;
	return Number.isFinite(n) ? n : fallback;
};

const isBlank = (v) => v === undefined || v === null || v === '';

/**
 * SVG path for a rectangle with the corners on ONE edge rounded by radius r.
 * `side='top'` rounds the top two corners (the growing end of a vertical column);
 * `side='right'` rounds the right two corners (the growing end of a horizontal bar).
 * The opposite edge stays square so segments butt flush against the baseline / each
 * other in stacked mode.
 */
const roundedRect = (x, y, w, h, r, side) => {
	if (side === 'right') {
		const rr = Math.max(0, Math.min(r, h / 2, w));
		if (rr <= 0 || w <= 0) {
			return `M${x},${y}h${w}v${h}h${-w}z`;
		}
		return (
			`M${x},${y}` +
			`h${w - rr}` +
			`a${rr},${rr} 0 0 1 ${rr},${rr}` +
			`v${h - 2 * rr}` +
			`a${rr},${rr} 0 0 1 ${-rr},${rr}` +
			`h${-(w - rr)}` +
			`z`
		);
	}
	const rr = Math.max(0, Math.min(r, w / 2, h));
	if (rr <= 0 || h <= 0) {
		return `M${x},${y}h${w}v${h}h${-w}z`;
	}
	return (
		`M${x},${y + rr}` +
		`a${rr},${rr} 0 0 1 ${rr},${-rr}` +
		`h${w - 2 * rr}` +
		`a${rr},${rr} 0 0 1 ${rr},${rr}` +
		`v${h - rr}` +
		`h${-w}` +
		`z`
	);
};

export function drawChart(container, props, dispatch) {
	// ----- normalize props (values may arrive as strings from the panel) -----
	const legendInteractive = props.legendInteractive === true;
	// allSeries = the validity-filtered master list (each tagged with its original index
	// _idx so colors stay stable when a series is hidden). legendInteractive hides series
	// by name; the hidden set lives on the stable container node so it survives the
	// redraw a legend click triggers. `series` is the visible subset that drives all
	// scales/bars, so hiding a series rescales the chart.
	const allSeries = (Array.isArray(props.series) ? props.series.filter((s) => s && Array.isArray(s.data)) : [])
		.map((s, i) => Object.assign({}, s, { _idx: i }));
	const nameOf = (s) => s.name || `Series ${s._idx + 1}`;
	const hidden = legendInteractive
		? (container.__ccHidden instanceof Set ? container.__ccHidden : (container.__ccHidden = new Set()))
		: new Set();
	const series = allSeries.filter((s) => !hidden.has(nameOf(s)));
	const groupMode = props.groupMode === 'stacked' ? 'stacked' : 'grouped';
	// vertical = columns (default); horizontal = bars. The renderer treats one axis
	// as the "category" axis (scaleBand) and the other as the "value" axis
	// (scaleLinear); orientation decides which is which.
	const orientation = props.orientation === 'horizontal' ? 'horizontal' : 'vertical';
	const horizontal = orientation === 'horizontal';
	// value-axis scale type; stacked-only offset; category-axis label thinning/rotation
	const yScaleType = ['linear', 'log', 'sqrt'].includes(props.yScaleType) ? props.yScaleType : 'linear';
	const stackOffset = ['none', 'expand', 'diverging'].includes(props.stackOffset) ? props.stackOffset : 'none';
	const colorScheme = props.colorScheme || 'custom';
	const xTickRotation = Math.max(-90, Math.min(90, num(props.xTickRotation, 0)));
	const xTickInterval = Math.max(1, Math.round(num(props.xTickInterval, 1)));
	const maxXTicks = Math.max(0, Math.round(num(props.maxXTicks, 0))); // 0 = no cap
	const palette = Array.isArray(props.colorPalette) && props.colorPalette.length
		? props.colorPalette
		: ['#2E93fA', '#66DA26', '#546E7A', '#E91E63', '#FF9800', '#9C27B0'];
	// A named scheme only *fills the palette*: explicit per-series data colors still win
	// (via colorFor's useSeriesColors guard); a scheme just replaces the fallback list.
	const effectivePalette = (colorScheme !== 'custom' && COLOR_SCHEMES[colorScheme]) ? COLOR_SCHEMES[colorScheme] : palette;
	const useSeriesColors = props.useSeriesColors !== false;
	const columnPadding = Math.max(0, Math.min(0.95, num(props.columnPadding, 0.2)));
	const groupPadding = Math.max(0, Math.min(0.5, num(props.groupPadding, 0.05)));
	const cornerRadius = Math.max(0, num(props.cornerRadius, 4));
	const yTickCount = Math.max(1, Math.round(num(props.yTickCount, 5)));
	const titleFontSize = num(props.titleFontSize, 18);
	const labelFontSize = num(props.labelFontSize, 12);
	const shadowBlur = Math.max(0, num(props.shadowBlur, 4));
	const animationDuration = Math.max(0, num(props.animationDuration, 800));
	const animate = props.animate !== false && animationDuration > 0;
	const animationStagger = Math.max(0, num(props.animationStagger, 0)); // ms delay per category
	const easeFn = EASINGS[props.animationEasing] || easeCubicOut;
	const barOpacity = Math.max(0, Math.min(1, num(props.barOpacity, 1)));
	const minBarHeight = Math.max(0, num(props.minBarHeight, 0)); // px floor (grouped only)
	const valueLabelPosition = ['inside', 'above', 'none'].includes(props.valueLabelPosition) ? props.valueLabelPosition : 'inside';
	const showXGridlines = props.showXGridlines === true;
	// bar fill style (solid | gradient | pattern); 3D front rounding; hover dim; clamp marker
	const barFillStyle = ['solid', 'gradient', 'pattern'].includes(props.barFillStyle) ? props.barFillStyle : 'solid';
	const barCornerRadius3D = props.barCornerRadius3D === true;
	const hoverDimOthers = props.hoverDimOthers === true;
	const clampOverflowIndicator = props.clampOverflowIndicator === true;
	// explicit value-axis ticks override the approximate yTickCount when provided
	const yAxisTickValues = Array.isArray(props.yAxisTickValues)
		? props.yAxisTickValues.map((v) => num(v, NaN)).filter((v) => Number.isFinite(v))
		: [];
	const hasYTickVals = yAxisTickValues.length > 0;
	// reference line: a number, or 'avg'/'mean' to auto-draw the mean of the (visible) data
	const refColor = props.referenceLineColor || '#ef4444';
	const refLabel = props.referenceLineLabel || '';
	let refValue = null;
	if (!isBlank(props.referenceLineValue)) {
		const rs = String(props.referenceLineValue).trim().toLowerCase();
		if (rs === 'avg' || rs === 'mean') {
			let sum = 0;
			let cnt = 0;
			series.forEach((s) => s.data.forEach((d) => { const v = num(d.value, NaN); if (Number.isFinite(v)) { sum += v; cnt += 1; } }));
			refValue = cnt ? sum / cnt : null;
		} else {
			const n = num(props.referenceLineValue, NaN);
			refValue = Number.isFinite(n) ? n : null;
		}
	}
	const dropShadow = props.dropShadow !== false;
	const showGridlines = props.showGridlines !== false;
	// Legend keys off the full list so it stays visible (to toggle hidden series back on).
	const showLegend = props.showLegend !== false && allSeries.length > 0;
	const showValueLabels = props.showValueLabels === true;
	const hoverHighlight = props.hoverHighlight !== false;
	const bar3D = props.bar3D !== false;
	const depth3D = Math.max(0, num(props.depth3D, 10));
	const legendPosition = ['top', 'right', 'bottom'].includes(props.legendPosition) ? props.legendPosition : 'top';
	const axisColor = props.axisColor || '#6b7280';
	const gridColor = props.gridColor || '#e5e7eb';
	const backgroundColor = props.backgroundColor || 'transparent';
	const fontFamily = props.fontFamily || 'inherit';
	const chartTitle = props.chartTitle || '';
	const xAxisLabel = props.xAxisLabel || '';
	const yAxisLabel = props.yAxisLabel || '';
	const hoverColor = props.hoverColor || '';
	const showTooltip = props.showTooltip !== false;
	const tooltipTemplate = isBlank(props.tooltipTemplate)
		? '<strong>{label}</strong><br/>{swatch}{seriesName}: {formattedValue}'
		: props.tooltipTemplate;
	const tooltipFollowCursor = props.tooltipFollowCursor !== false;
	const tooltipBackground = props.tooltipBackground || 'rgba(17,24,39,0.92)';
	const tooltipTextColor = props.tooltipTextColor || '#ffffff';
	const tooltipFontSize = num(props.tooltipFontSize, 12);
	// independent typography: title, axes (tick values + axis titles), legend.
	// labelFontSize now applies to the in-bar data labels only.
	const titleColor = props.titleColor || '#374151';
	const axisTextColor = props.axisTextColor || '#6b7280';
	const axisFontSize = num(props.axisFontSize, 12);
	const axisFontFamily = props.axisFontFamily || fontFamily;
	const legendFontSize = num(props.legendFontSize, 12);
	// Two independent formatters: one for the column value labels, one for the
	// y-axis ticks. Either can be left blank (default) without affecting the other.
	const makeFmt = (spec) => {
		if (isBlank(spec)) return (n) => `${n}`;
		try { return format(spec); } catch (e) { return (n) => `${n}`; }
	};
	const fmt = makeFmt(props.valueLabelFormat);
	// 100%-normalized stacks read as percentages, so default the y-axis ticks to a
	// percent format when the author hasn't set one explicitly.
	const yFmt = (groupMode === 'stacked' && stackOffset === 'expand' && isBlank(props.yAxisFormat))
		? format('.0%')
		: makeFmt(props.yAxisFormat);

	const colorFor = (s, i) => (useSeriesColors && s && s.color ? s.color : effectivePalette[i % effectivePalette.length]);
	const hoverFill = (base) => {
		if (hoverColor) return hoverColor;
		const c = color(base);
		return c ? c.brighter(0.5).toString() : base;
	};
	// pick dark or light label text based on the fill's perceived brightness
	const autoContrast = (base) => {
		const c = color(base);
		if (!c) return '#ffffff';
		const { r, g, b } = c.rgb();
		return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111111' : '#ffffff';
	};

	// ----- clear previous render -----
	const root = select(container);
	root.selectAll('*').remove();

	// ----- dimensions -----
	// Measure the container robustly; in a UI Builder slot getBoundingClientRect()
	// can read 0 at first paint, so fall back to clientWidth then a sane default.
	const rect = container.getBoundingClientRect();
	const measuredW = Math.floor(rect.width) || container.clientWidth || 0;
	const width = Math.max(220, measuredW || 600);
	// Height is driven by the chartHeight property (the container's min-height would
	// otherwise clamp it). This is the knob authors use to make the chart taller.
	const height = Math.max(120, num(props.chartHeight, 360));

	// ----- categories & series names -----
	const categories = series.length ? series[0].data.map((d) => d.label) : [];
	const seriesNames = series.map((s) => nameOf(s));
	const allSeriesNames = allSeries.map((s) => nameOf(s)); // for the legend (incl. hidden)
	const valueByCat = (s, label) => {
		const hit = s.data.find((d) => d.label === label);
		return hit ? num(hit.value, 0) : 0;
	};

	// ----- root svg + click target -----
	const svg = root
		.append('svg')
		.attr('class', 'cc-svg')
		.attr('width', width)
		.attr('height', height)
		.attr('viewBox', `0 0 ${width} ${height}`)
		.style('font-family', fontFamily)
		.style('display', 'block')
		.on('click', (event) => {
			dispatch('CHART_CLICKED', {
				seriesCount: series.length,
				categoryCount: categories.length
			});
		});

	// background
	svg.append('rect')
		.attr('class', 'cc-bg')
		.attr('width', width)
		.attr('height', height)
		.attr('fill', backgroundColor);

	// drop-shadow filter
	if (dropShadow) {
		const defs = svg.append('defs');
		const filter = defs.append('filter')
			.attr('id', 'cc-shadow')
			.attr('x', '-30%').attr('y', '-30%')
			.attr('width', '160%').attr('height', '160%');
		filter.append('feDropShadow')
			.attr('dx', 0)
			.attr('dy', 1)
			.attr('stdDeviation', shadowBlur)
			.attr('flood-color', props.shadowColor || 'rgba(0,0,0,0.25)');
	}

	if (!series.length || !categories.length) {
		svg.append('text')
			.attr('x', width / 2).attr('y', height / 2)
			.attr('text-anchor', 'middle')
			.attr('fill', axisColor)
			.style('font-size', `${labelFontSize}px`)
			.text('No data to display');
		return;
	}

	// ----- layout margins (depend on which decorations are shown) -----
	const margin = { top: 12, right: 16, bottom: Math.max(24, axisFontSize + 12), left: Math.max(48, axisFontSize * 3) };
	const longestCat = categories.reduce((m, c) => Math.max(m, String(c).length), 0);
	if (horizontal) {
		// category labels move to the left axis and can be long, so size the left
		// margin to the widest label (capped) instead of the value-tick width.
		margin.left = Math.max(48, Math.min(220, Math.round(longestCat * axisFontSize * 0.6) + 18));
	}
	// Rotated category labels need extra room along the axis they sit on: estimate the
	// vertical footprint of the tilted text and reserve it (bottom for columns).
	const rotatedExtent = xTickRotation
		? Math.round(Math.sin(Math.abs(xTickRotation) * Math.PI / 180) * longestCat * axisFontSize * 0.6)
		: 0;
	if (rotatedExtent && !horizontal) margin.bottom += rotatedExtent;
	// 'above' value labels sit just past the bar's value end — reserve room so the
	// top-most (columns) / right-most (bars) labels don't clip.
	if (showValueLabels && valueLabelPosition === 'above') {
		if (horizontal) margin.right += Math.max(24, labelFontSize * 2.5);
		else margin.top += labelFontSize + 8;
	}
	if (chartTitle) margin.top += titleFontSize + 22; // extra breathing room below the title
	// xAxisLabel titles the category axis, yAxisLabel the value axis. Each follows its
	// axis to the bottom or left depending on orientation.
	const catTitleOnLeft = horizontal;
	const valTitleOnLeft = !horizontal;
	if (xAxisLabel) { if (catTitleOnLeft) margin.left += axisFontSize + 8; else margin.bottom += axisFontSize + 10; }
	if (yAxisLabel) { if (valTitleOnLeft) margin.left += axisFontSize + 8; else margin.bottom += axisFontSize + 10; }

	const legendRowH = legendFontSize + 12;
	const legendItemW = (name) => 18 + name.length * (legendFontSize * 0.62) + 16;
	if (showLegend) {
		if (legendPosition === 'top') margin.top += legendRowH;
		else if (legendPosition === 'bottom') margin.bottom += legendRowH + 12; // gap below the x-axis label
		else margin.right += Math.min(180, Math.max(...allSeriesNames.map(legendItemW)) + 8);
	}

	const innerW = Math.max(10, width - margin.left - margin.right);
	const innerH = Math.max(10, height - margin.top - margin.bottom);
	const plot = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

	// ----- scales -----
	// x0/x1 are the category + grouped-sub scales; they run across innerW for vertical
	// columns and down innerH for horizontal bars. `y` is the value scale and runs the
	// other way (up for columns, rightward for bars).
	const catExtent = horizontal ? innerH : innerW;
	const x0 = scaleBand().domain(categories).range([0, catExtent]).paddingInner(columnPadding).paddingOuter(columnPadding / 2);
	const x1 = scaleBand().domain(seriesNames).range([0, x0.bandwidth()]).padding(groupPadding);

	// ----- value domain -----
	// expand (100%) always normalizes to [0,1]; diverging needs separate positive and
	// negative extents; otherwise track the natural min/max. minPos feeds the log scale,
	// which has no zero and must floor on the smallest positive value.
	const expandMode = groupMode === 'stacked' && stackOffset === 'expand';
	let dataMin = 0;
	let dataMax = 0;
	let minPos = Infinity;
	series.forEach((s) => s.data.forEach((d) => {
		const v = num(d.value, 0);
		if (v > 0 && v < minPos) minPos = v;
	}));
	if (groupMode === 'stacked') {
		if (expandMode) {
			dataMax = 1;
		} else if (stackOffset === 'diverging') {
			categories.forEach((label) => {
				let pos = 0;
				let neg = 0;
				series.forEach((s) => { const v = valueByCat(s, label); if (v >= 0) pos += v; else neg += v; });
				dataMax = Math.max(dataMax, pos);
				dataMin = Math.min(dataMin, neg);
			});
		} else {
			categories.forEach((label) => {
				const total = series.reduce((acc, s) => acc + Math.max(0, valueByCat(s, label)), 0);
				dataMax = Math.max(dataMax, total);
			});
		}
	} else {
		series.forEach((s) => s.data.forEach((d) => {
			const v = num(d.value, 0);
			dataMin = Math.min(dataMin, v);
			dataMax = Math.max(dataMax, v);
		}));
	}
	const yLo = expandMode ? 0 : (isBlank(props.yMin) ? Math.min(0, dataMin) : num(props.yMin, Math.min(0, dataMin)));
	const yHi = expandMode ? 1 : (isBlank(props.yMax) ? dataMax || 1 : num(props.yMax, dataMax || 1));

	// ----- value scale (linear | log | sqrt) -----
	// valBase = the data value the bars grow FROM (the visual baseline): 0 for linear/
	// sqrt, the domain floor for log (which can't reach 0). clamp(true) truncates bars
	// at the bounds; nice() only rounds when the bound is automatic.
	const valRange = horizontal ? [0, innerW] : [innerH, 0];
	const autoBounds = isBlank(props.yMin) && isBlank(props.yMax) && !expandMode;
	let y;
	let valBase;
	if (yScaleType === 'log') {
		const floor = Number.isFinite(minPos) ? minPos : 1;
		const lo = isBlank(props.yMin) ? floor : Math.max(1e-6, num(props.yMin, floor));
		const hi = isBlank(props.yMax) ? (dataMax || 10) : num(props.yMax, dataMax || 10);
		y = scaleLog().domain([lo, Math.max(hi, lo * 10)]).range(valRange).clamp(true);
		if (autoBounds) y.nice();
		valBase = y.domain()[0]; // bars sit on the (post-nice) domain floor
	} else if (yScaleType === 'sqrt') {
		y = scaleSqrt().domain([yLo, yHi]).range(valRange).clamp(true);
		if (autoBounds) y.nice(yTickCount);
		valBase = Math.max(yLo, 0);
	} else {
		y = scaleLinear().domain([yLo, yHi]).range(valRange).clamp(true);
		if (autoBounds) y.nice(yTickCount);
		valBase = Math.max(yLo, 0);
	}

	// Value-axis ticks: explicit yAxisTickValues when given, else the approximate count.
	const valueTicks = (gen) => (hasYTickVals ? gen.tickValues(yAxisTickValues) : gen.ticks(yTickCount));

	// ----- gridlines -----
	// Gridlines run perpendicular to the value axis: horizontal lines for columns,
	// vertical lines for bars (drawn from the bottom value-axis upward across innerH).
	if (showGridlines) {
		const grid = plot.append('g').attr('class', 'cc-grid');
		if (horizontal) {
			grid.attr('transform', `translate(0,${innerH})`)
				.call(valueTicks(axisBottom(y)).tickSize(-innerH).tickFormat(''));
		} else {
			grid.call(valueTicks(axisLeft(y)).tickSize(-innerW).tickFormat(''));
		}
		grid.call((g) => g.select('.domain').remove())
			.call((g) => g.selectAll('line').attr('stroke', gridColor).attr('stroke-dasharray', '2,2'));
	}

	// ----- axes -----
	// xAxis = category axis, yAxis = value axis (kept semantic so styling + axis-title
	// code is orientation-agnostic). Vertical: categories on the bottom at the value
	// baseline, values on the left. Horizontal: categories on the left at the value
	// baseline, values along the bottom.
	const valZero = y(valBase);
	// Thin the category labels: show every Nth (xTickInterval), and/or auto-thin so no
	// more than maxXTicks remain. Only the labels/ticks drop out — every bar still draws.
	let catInterval = xTickInterval;
	if (maxXTicks > 0 && categories.length > maxXTicks) {
		catInterval = Math.max(catInterval, Math.ceil(categories.length / maxXTicks));
	}
	const catTickVals = catInterval > 1 ? categories.filter((c, i) => i % catInterval === 0) : categories;

	// Optional category-axis gridlines (perpendicular to the value gridlines): vertical
	// lines for columns, horizontal lines for bars. Drawn before the bars so they sit
	// behind them; aligned to the same (possibly thinned) category ticks.
	if (showXGridlines) {
		const xgrid = plot.append('g').attr('class', 'cc-grid cc-grid-x');
		if (horizontal) {
			xgrid.call(axisLeft(x0).tickValues(catTickVals).tickSize(-innerW).tickFormat(''));
		} else {
			xgrid.attr('transform', `translate(0,${innerH})`)
				.call(axisBottom(x0).tickValues(catTickVals).tickSize(-innerH).tickFormat(''));
		}
		xgrid.call((g) => g.select('.domain').remove())
			.call((g) => g.selectAll('line').attr('stroke', gridColor).attr('stroke-dasharray', '2,2'));
	}

	let xAxis;
	let yAxis;
	if (horizontal) {
		xAxis = plot.append('g')
			.attr('class', 'cc-axis cc-axis-x')
			.attr('transform', `translate(${valZero},0)`)
			.call(axisLeft(x0).tickValues(catTickVals).tickSizeOuter(0));
		yAxis = plot.append('g')
			.attr('class', 'cc-axis cc-axis-y')
			.attr('transform', `translate(0,${innerH})`)
			.call(valueTicks(axisBottom(y)).tickFormat(yFmt));
	} else {
		xAxis = plot.append('g')
			.attr('class', 'cc-axis cc-axis-x')
			.attr('transform', `translate(0,${valZero})`)
			.call(axisBottom(x0).tickValues(catTickVals).tickSizeOuter(0));
		yAxis = plot.append('g')
			.attr('class', 'cc-axis cc-axis-y')
			.call(valueTicks(axisLeft(y)).tickFormat(yFmt));
	}

	[xAxis, yAxis].forEach((axis) => {
		axis.selectAll('path,line').attr('stroke', axisColor); // axis line color
		axis.selectAll('text') // tick value text uses the axis typography
			.attr('fill', axisTextColor)
			.style('font-size', `${axisFontSize}px`)
			.style('font-family', axisFontFamily);
	});

	// Rotate the category-axis labels so long/dense labels don't collide. Anchor the
	// text to the end nearest the axis so it pivots cleanly off each tick.
	if (xTickRotation !== 0) {
		const anchor = xTickRotation < 0 ? 'end' : (xTickRotation > 0 ? 'start' : 'middle');
		xAxis.selectAll('text')
			.attr('transform', `rotate(${xTickRotation})`)
			.style('text-anchor', anchor)
			.attr('dx', horizontal ? null : (xTickRotation < 0 ? '-0.4em' : (xTickRotation > 0 ? '0.4em' : null)))
			.attr('dy', horizontal ? '0.32em' : (Math.abs(xTickRotation) >= 60 ? '0.3em' : '0.6em'));
	}

	// ----- build flat bar descriptors (unifies grouped & stacked) -----
	const yBase = y(valBase); // baseline pixel
	const bars = [];
	categories.forEach((label, ci) => {
		let cum = 0;    // running total for 'none' / 'expand' offsets
		let posCum = 0; // diverging: positive segments stack up from 0
		let negCum = 0; // diverging: negative segments stack down from 0
		// expand needs the category's signed total up front to normalize each segment
		const expandTotal = expandMode
			? (series.reduce((acc, s) => acc + valueByCat(s, label), 0) || 1)
			: 1;
		series.forEach((s, si) => {
			const datum = s.data.find((d) => d.label === label) || {};
			const value = valueByCat(s, label);
			let bx;
			let bw;
			let y0;
			let y1;
			if (groupMode === 'stacked') {
				bx = x0(label);
				bw = x0.bandwidth();
				if (expandMode) {
					const frac = value / expandTotal;
					y0 = cum;
					y1 = cum + frac;
					cum = y1;
				} else if (stackOffset === 'diverging') {
					if (value >= 0) { y0 = posCum; y1 = posCum + value; posCum = y1; }
					else { y0 = negCum; y1 = negCum + value; negCum = y1; }
				} else {
					y0 = cum;
					y1 = cum + value;
					cum = y1;
				}
			} else {
				bx = x0(label) + x1(nameOf(s));
				bw = x1.bandwidth();
				y0 = valBase;
				y1 = value;
			}
			let pyBase = y(y0);
			let pyTop = y(y1);
			// minBarHeight: floor the rendered length so tiny non-zero values stay
			// visible/clickable. Grouped only — flooring stacked segments would push the
			// stack past its total and misalign the pieces.
			if (minBarHeight > 0 && groupMode !== 'stacked' && value !== 0 && Math.abs(pyTop - pyBase) < minBarHeight) {
				const growDir = horizontal ? (value >= 0 ? 1 : -1) : (value >= 0 ? -1 : 1);
				pyTop = pyBase + growDir * minBarHeight;
			}
			bars.push({
				seriesName: seriesNames[si],
				seriesIndex: si,
				colorIdx: s._idx, // original index → stable gradient/pattern def id
				label,
				categoryIndex: ci,
				value,
				vEnd: y1, // end value in data terms (for the clamp-overflow check)
				color: colorFor(s, s._idx),
				bx, bw,
				pyBase,
				pyTop,
				isTopSegment: groupMode !== 'stacked' || si === series.length - 1,
				raw: datum // original data point, so tooltip templates can use custom keys
			});
		});
	});

	// category totals (for the {percent} tooltip token)
	const catTotals = {};
	bars.forEach((b) => { catTotals[b.label] = (catTotals[b.label] || 0) + (b.value || 0); });

	// ----- columns (flat or extruded 3D) -----
	const barData = bars.filter((b) => b.value !== 0);
	const depthFor = (d) => Math.max(0, Math.min(depth3D, d.bw * 0.5));
	const topShade = (c) => { const col = color(c); return col ? col.brighter(0.5).toString() : c; };
	const sideShade = (c) => { const col = color(c); return col ? col.darker(0.7).toString() : c; };

	// ----- bar fill style (gradient / pattern defs) -----
	// One def per series original index so ids stay stable when a series is hidden.
	// Patterns keep the series color as the tile background with a darker motif overlay
	// (color + texture, colorblind-friendlier). Gradients run along the value axis.
	const buildGradient = (defs, idx, col) => {
		const c = color(col);
		const lighter = c ? c.brighter(0.35).toString() : col;
		const g = defs.append('linearGradient').attr('id', `cc-grad-${idx}`)
			.attr('x1', 0).attr('y1', 0)
			.attr('x2', horizontal ? 1 : 0).attr('y2', horizontal ? 0 : 1);
		// the value-end of the bar gets the lighter stop (top for columns, right for bars)
		const ends = horizontal ? [col, lighter] : [lighter, col];
		g.append('stop').attr('offset', '0%').attr('stop-color', ends[0]);
		g.append('stop').attr('offset', '100%').attr('stop-color', ends[1]);
	};
	const buildPattern = (defs, idx, col) => {
		const size = 6;
		const sw = 1.4;
		const stroke = sideShade(col);
		const p = defs.append('pattern').attr('id', `cc-pat-${idx}`)
			.attr('patternUnits', 'userSpaceOnUse').attr('width', size).attr('height', size);
		p.append('rect').attr('width', size).attr('height', size).attr('fill', col);
		const line = (dd) => p.append('path').attr('d', dd).attr('stroke', stroke).attr('stroke-width', sw).attr('fill', 'none');
		const motif = ((idx % 6) + 6) % 6;
		if (motif === 0) line(`M0,${size}l${size},${-size}`);          // diagonal /
		else if (motif === 1) line(`M0,0l${size},${size}`);            // diagonal \
		else if (motif === 2) line(`M0,${size}l${size},${-size}M0,0l${size},${size}`); // cross-hatch
		else if (motif === 3) p.append('circle').attr('cx', size / 2).attr('cy', size / 2).attr('r', 1.3).attr('fill', stroke); // dots
		else if (motif === 4) line(`M0,${size / 2}h${size}`);          // horizontal
		else line(`M${size / 2},0v${size}`);                           // vertical
	};
	if (barFillStyle !== 'solid') {
		const fillDefs = svg.append('defs');
		allSeries.forEach((s) => {
			const col = colorFor(s, s._idx);
			if (barFillStyle === 'pattern') buildPattern(fillDefs, s._idx, col);
			else buildGradient(fillDefs, s._idx, col);
		});
	}
	const frontFill = (d) => (
		barFillStyle === 'pattern' ? `url(#cc-pat-${d.colorIdx})`
			: barFillStyle === 'gradient' ? `url(#cc-grad-${d.colorIdx})`
				: d.color
	);

	// Build the front/top/side face paths for a given grown value-axis length `len`
	// (>= 0). bx/bw are the bar's extent along the CATEGORY axis; pyBase/pyTop are its
	// base/end pixels along the VALUE axis. We resolve those into the front-face
	// rectangle (rx,ry,rw,rh), then the 3D top/side faces share one isometric
	// up-right depth offset so both orientations read as the same solid.
	const facePaths = (d, len) => {
		const dep = depthFor(d);
		let rx;
		let ry;
		let rw;
		let rh;
		let roundSide;
		if (horizontal) {
			const growsRight = d.pyTop >= d.pyBase;
			rx = growsRight ? d.pyBase : d.pyBase - len;
			ry = d.bx;
			rw = len;
			rh = d.bw;
			roundSide = 'right';
		} else {
			const growsUp = d.pyTop <= d.pyBase;
			rx = d.bx;
			ry = growsUp ? d.pyBase - len : d.pyBase;
			rw = d.bw;
			rh = len;
			roundSide = 'top';
		}
		// front corners round in 2D always, and in 3D when barCornerRadius3D is on
		const fr = ((!bar3D || barCornerRadius3D) && d.isTopSegment) ? cornerRadius : 0;
		return {
			front: roundedRect(rx, ry, rw, rh, fr, roundSide),
			top: `M${rx},${ry}l${dep},${-dep}h${rw}l${-dep},${dep}z`,
			side: `M${rx + rw},${ry}l${dep},${-dep}v${rh}l${-dep},${dep}z`
		};
	};
	const paintGroup = (g, d, hh) => {
		const f = facePaths(d, hh);
		g.select('.cc-face-front').attr('d', f.front);
		g.select('.cc-face-top').attr('d', f.top);
		g.select('.cc-face-side').attr('d', f.side);
	};
	const recolorGroup = (g, baseColor) => {
		g.select('.cc-face-front').attr('fill', baseColor);
		g.select('.cc-face-top').attr('fill', topShade(baseColor));
		g.select('.cc-face-side').attr('fill', sideShade(baseColor));
	};
	// restore the resting fills after a hover (front returns to its gradient/pattern/solid)
	const restoreGroup = (g, d) => {
		g.select('.cc-face-front').attr('fill', frontFill(d));
		g.select('.cc-face-top').attr('fill', topShade(d.color));
		g.select('.cc-face-side').attr('fill', sideShade(d.color));
	};

	// ----- tooltip -----
	// HTML overlay inside the container (a sibling of the svg). .cc-root is
	// position:relative (styles.scss) so absolute positioning is relative to it.
	const tooltipEl = showTooltip
		? root.append('div').attr('class', 'cc-tooltip')
			.style('background', tooltipBackground)
			.style('color', tooltipTextColor)
			.style('font-size', `${tooltipFontSize}px`)
			.style('font-family', fontFamily)
			.style('opacity', 0)
			.style('display', 'none')
		: null;

	const escapeHtml = (s) => String(s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

	// Resolve the template against a bar's context (custom keys via d.raw, plus derived tokens).
	// {swatch} injects a colored dot matching the series; sanitize the color so it
	// can't break out of the inline style attribute.
	const swatchHtml = (cssColor) => {
		const safe = String(cssColor).replace(/[^a-zA-Z0-9#(),.%\s-]/g, '');
		return `<span class="cc-tt-swatch" style="background:${safe}"></span>`;
	};
	const renderTooltip = (d) => {
		const total = catTotals[d.label] || 0;
		const pct = total ? (d.value / total) * 100 : 0;
		const ctx = Object.assign({}, d.raw || {}, {
			label: d.label,
			value: d.value,
			formattedValue: fmt(d.value),
			seriesName: d.seriesName,
			seriesIndex: d.seriesIndex,
			categoryIndex: d.categoryIndex,
			percent: `${Math.round(pct * 10) / 10}%`,
			color: d.color
		});
		// template HTML is preserved; {swatch} injects a colored dot; other values are escaped
		return tooltipTemplate.replace(/\{(\w+)\}/g, (m, key) => {
			if (key === 'swatch') { return swatchHtml(d.color); }
			const v = ctx[key];
			return (v === undefined || v === null) ? '' : escapeHtml(v);
		});
	};

	const moveTooltip = (event, d) => {
		if (!tooltipEl) return;
		const rect = container.getBoundingClientRect();
		const node = tooltipEl.node();
		const tw = node.offsetWidth;
		const th = node.offsetHeight;
		let x;
		let yTop;
		if (tooltipFollowCursor) {
			x = event.clientX - rect.left + 14;
			yTop = event.clientY - rect.top + 14;
			if (yTop + th > rect.height) { yTop = event.clientY - rect.top - th - 14; }
		} else if (horizontal) {
			// anchor just past the bar's value end, vertically centered on the bar
			const valEnd = margin.left + Math.max(d.pyBase, d.pyTop) + (bar3D ? depthFor(d) : 0);
			const cy = margin.top + d.bx + d.bw / 2 - (bar3D ? depthFor(d) / 2 : 0);
			x = valEnd + 10;
			yTop = cy - th / 2;
		} else {
			const cx = margin.left + d.bx + d.bw / 2 + (bar3D ? depthFor(d) / 2 : 0);
			const barTop = margin.top + Math.min(d.pyTop, d.pyBase) - (bar3D ? depthFor(d) : 0);
			x = cx - tw / 2;
			yTop = barTop - th - 8;
			if (yTop < 0) { yTop = barTop + 8; }
		}
		// keep inside the chart bounds
		if (x + tw > rect.width) { x = rect.width - tw - 4; }
		if (x < 0) { x = 4; }
		if (yTop < 0) { yTop = 4; }
		tooltipEl.style('left', `${x}px`).style('top', `${yTop}px`);
	};

	const groups = plot.append('g')
		.attr('class', 'cc-bars')
		.attr('filter', dropShadow ? 'url(#cc-shadow)' : null)
		.style('fill-opacity', barOpacity) // applies to all three 3D faces; labels stay opaque
		.selectAll('g.cc-bar')
		.data(barData)
		.join('g')
		.attr('class', 'cc-bar')
		.attr('tabindex', 0)
		.attr('role', 'button')
		.attr('aria-label', (d) => `${d.seriesName}, ${d.label}: ${fmt(d.value)}`)
		.style('cursor', 'pointer');

	// Face elements, painted back-to-front. The "wall" runs the bar's full value-axis
	// length on every segment; the brighter end "cap" only closes the value end (the
	// top segment in stacked mode). Vertical: wall = right side, cap = top. Horizontal:
	// wall = top, cap = right side. The cc-face-top/-side classes keep their shading so
	// hover recolor stays orientation-agnostic.
	groups.each(function (d) {
		const g = select(this);
		if (bar3D) {
			if (horizontal) g.append('path').attr('class', 'cc-face-top').attr('fill', topShade(d.color));
			else g.append('path').attr('class', 'cc-face-side').attr('fill', sideShade(d.color));
		}
		g.append('path').attr('class', 'cc-face-front').attr('fill', frontFill(d));
		if (bar3D && d.isTopSegment) {
			if (horizontal) g.append('path').attr('class', 'cc-face-side').attr('fill', sideShade(d.color));
			else g.append('path').attr('class', 'cc-face-top').attr('fill', topShade(d.color));
		}
	});

	groups
		.on('mouseenter', function (event, d) {
			if (hoverHighlight) recolorGroup(select(this), hoverFill(d.color));
			if (hoverDimOthers) { groups.style('opacity', 0.3); select(this).style('opacity', 1); }
			if (tooltipEl) {
				tooltipEl.html(renderTooltip(d)).style('display', 'block').style('opacity', 1);
				moveTooltip(event, d);
			}
			dispatch('COLUMN_HOVERED', { seriesName: d.seriesName, label: d.label, value: d.value });
		})
		.on('mousemove', function (event, d) {
			if (tooltipEl) moveTooltip(event, d);
		})
		.on('mouseleave', function (event, d) {
			if (hoverHighlight) restoreGroup(select(this), d); // back to gradient/pattern/solid
			if (hoverDimOthers) groups.style('opacity', 1);
			if (tooltipEl) tooltipEl.style('opacity', 0).style('display', 'none');
		})
		.on('click', function (event, d) {
			event.stopPropagation(); // don't also fire CHART_CLICKED
			dispatch('COLUMN_CLICKED', {
				seriesName: d.seriesName,
				label: d.label,
				value: d.value,
				seriesIndex: d.seriesIndex,
				categoryIndex: d.categoryIndex
			});
		});

	// grow-in animation via requestAnimationFrame (no d3-transition dependency, so
	// nothing here can be tree-shaken out of the production bundle). Easing is chosen by
	// animationEasing; animationStagger delays each category for a left-to-right cascade.
	const fullH = (d) => Math.abs(d.pyBase - d.pyTop);
	const delayFor = (d) => animationStagger * d.categoryIndex;
	const maxDelay = animationStagger * Math.max(0, categories.length - 1);
	if (animate && typeof requestAnimationFrame === 'function') {
		groups.each(function (d) { paintGroup(select(this), d, 0); });
		const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : new Date().getTime());
		const t0 = now();
		const tick = () => {
			const elapsed = now() - t0;
			groups.each(function (d) {
				const k = easeFn(Math.max(0, Math.min(1, (elapsed - delayFor(d)) / animationDuration)));
				paintGroup(select(this), d, fullH(d) * k);
			});
			if (elapsed < animationDuration + maxDelay) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	} else {
		groups.each(function (d) { paintGroup(select(this), d, fullH(d)); });
	}

	// ----- value labels -----
	if (showValueLabels && valueLabelPosition !== 'none') {
		const above = valueLabelPosition === 'above';
		const fontPx = Math.max(9, labelFontSize - 1);
		const gap = 4;
		// 'inside' keeps labels centered in each segment (skip ones too short to fit);
		// 'above' places them just past the bar's value end (every non-zero bar).
		const data = above
			? bars.filter((b) => b.value !== 0)
			: bars.filter((b) => b.value !== 0 && Math.abs(b.pyBase - b.pyTop) >= labelFontSize + 2);
		// 'above' geometry: sit just beyond the value end in the grow direction, nudged
		// out past the 3D extrusion. Inside geometry centers on the segment's front face.
		const aboveX = (d) => {
			if (horizontal) {
				const end = d.value >= 0 ? Math.max(d.pyBase, d.pyTop) : Math.min(d.pyBase, d.pyTop);
				return end + (d.value >= 0 ? 1 : -1) * (gap + (bar3D ? depthFor(d) : 0));
			}
			return d.bx + d.bw / 2 + (bar3D ? depthFor(d) / 2 : 0);
		};
		const aboveY = (d) => {
			if (horizontal) return d.bx + d.bw / 2 - (bar3D ? depthFor(d) / 2 : 0);
			const end = d.value >= 0 ? Math.min(d.pyBase, d.pyTop) : Math.max(d.pyBase, d.pyTop);
			return end + (d.value >= 0 ? -1 : 1) * (gap + (bar3D ? depthFor(d) : 0));
		};
		const labels = plot.append('g').attr('class', 'cc-value-labels')
			.selectAll('text')
			.data(data)
			.join('text')
			.attr('x', (d) => (above ? aboveX(d) : (horizontal ? (d.pyBase + d.pyTop) / 2 : d.bx + d.bw / 2)))
			.attr('y', (d) => (above ? aboveY(d) : (horizontal ? d.bx + d.bw / 2 : (d.pyBase + d.pyTop) / 2)))
			.attr('text-anchor', (d) => (above ? (horizontal ? (d.value >= 0 ? 'start' : 'end') : 'middle') : 'middle'))
			.attr('dominant-baseline', (d) => (above ? (horizontal ? 'central' : (d.value >= 0 ? 'auto' : 'hanging')) : 'central'))
			.attr('fill', (d) => (above ? axisTextColor : autoContrast(d.color)))
			.style('font-size', `${fontPx}px`)
			.style('font-weight', '600')
			.style('pointer-events', 'none')
			.style('opacity', animate ? 0 : 1)
			.text((d) => fmt(d.value));
		// fade labels in after the bars finish growing (incl. the stagger tail)
		if (animate && typeof requestAnimationFrame === 'function') {
			labels.style('transition', `opacity 300ms ease ${Math.round((animationDuration + maxDelay) * 0.5)}ms`);
			requestAnimationFrame(() => labels.style('opacity', 1));
		}
	}

	// ----- clamp overflow indicator -----
	// When a bar's end value exceeds the (explicit) value-axis bounds, clamp(true) cut it
	// off silently. Mark those bars with a small zigzag "torn edge" at the clamped end so
	// the truncation is visible. Auto bounds never overflow, so this only fires with a
	// user-set yMin/yMax (or the log floor).
	if (clampOverflowIndicator) {
		const dMin = y.domain()[0];
		const dMax = y.domain()[1];
		const overflowed = barData.filter((d) => d.vEnd > dMax + 1e-9 || d.vEnd < dMin - 1e-9);
		const zig = (d) => {
			const amp = 3;
			const teeth = Math.max(2, Math.round(d.bw / 5));
			const step = d.bw / teeth;
			if (horizontal) {
				let path = `M${d.pyTop},${d.bx}`;
				for (let i = 1; i <= teeth; i++) {
					path += `L${d.pyTop + (i % 2 === 0 ? amp : -amp)},${d.bx + step * i}`;
				}
				return path;
			}
			let path = `M${d.bx},${d.pyTop}`;
			for (let i = 1; i <= teeth; i++) {
				path += `L${d.bx + step * i},${d.pyTop + (i % 2 === 0 ? amp : -amp)}`;
			}
			return path;
		};
		if (overflowed.length) {
			plot.append('g').attr('class', 'cc-overflow').style('pointer-events', 'none')
				.selectAll('path').data(overflowed).join('path')
				.attr('d', zig)
				.attr('fill', 'none')
				.attr('stroke', (d) => autoContrast(d.color))
				.attr('stroke-width', 1.5)
				.attr('stroke-linejoin', 'round');
		}
	}

	// ----- reference line -----
	// Target/average threshold across the plot at the value pixel y(refValue). Drawn
	// after the bars/labels so it overlays them; reuses the value scale (a value outside
	// the domain clamps to the axis edge).
	if (refValue !== null && Number.isFinite(refValue)) {
		const p = y(refValue);
		const refG = plot.append('g').attr('class', 'cc-refline').style('pointer-events', 'none');
		refG.append('line')
			.attr('x1', horizontal ? p : 0)
			.attr('y1', horizontal ? 0 : p)
			.attr('x2', horizontal ? p : innerW)
			.attr('y2', horizontal ? innerH : p)
			.attr('stroke', refColor)
			.attr('stroke-width', 1.5)
			.attr('stroke-dasharray', '6,4');
		if (refLabel) {
			refG.append('text')
				.attr('x', horizontal ? p + 4 : innerW - 4)
				.attr('y', horizontal ? 2 : p - 4)
				.attr('text-anchor', horizontal ? 'middle' : 'end')
				.attr('dominant-baseline', horizontal ? 'hanging' : 'auto')
				.attr('fill', refColor)
				.style('font-size', `${axisFontSize}px`)
				.style('font-family', axisFontFamily)
				.style('font-weight', '600')
				.text(refLabel);
		}
	}

	// ----- title -----
	if (chartTitle) {
		svg.append('text')
			.attr('class', 'cc-title')
			.attr('x', width / 2)
			.attr('y', (showLegend && legendPosition === 'top' ? legendRowH : 0) + titleFontSize + 2)
			.attr('text-anchor', 'middle')
			.attr('fill', titleColor)
			.style('font-size', `${titleFontSize}px`)
			.style('font-weight', '600')
			.text(chartTitle);
	}

	// ----- axis titles -----
	// xAxisLabel titles the category axis, yAxisLabel the value axis. Each renders on
	// the physical side its axis occupies: vertical → categories bottom / values left;
	// horizontal → categories left / values bottom. bottomCursor walks down the area
	// beneath the plot (past the value/category tick labels) before the bottom legend.
	const plotBottom = margin.top + innerH;
	let bottomCursor = plotBottom + Math.max(20, axisFontSize + 8) + (horizontal ? 0 : rotatedExtent);
	const bottomTitle = horizontal ? yAxisLabel : xAxisLabel;
	const leftTitle = horizontal ? xAxisLabel : yAxisLabel;
	if (bottomTitle) {
		svg.append('text')
			.attr('class', 'cc-axis-title')
			.attr('x', margin.left + innerW / 2)
			.attr('y', bottomCursor + axisFontSize)
			.attr('text-anchor', 'middle')
			.attr('fill', axisTextColor)
			.style('font-size', `${axisFontSize}px`)
			.style('font-family', axisFontFamily)
			.text(bottomTitle);
		bottomCursor += axisFontSize + 14; // clear gap before the legend row
	}
	if (leftTitle) {
		svg.append('text')
			.attr('class', 'cc-axis-title')
			.attr('transform', `translate(${14},${margin.top + innerH / 2}) rotate(-90)`)
			.attr('text-anchor', 'middle')
			.attr('fill', axisTextColor)
			.style('font-size', `${axisFontSize}px`)
			.style('font-family', axisFontFamily)
			.text(leftTitle);
	}

	// ----- legend -----
	// Binds to allSeries (so hidden series still show, dimmed/struck-through to toggle
	// back). When legendInteractive, clicking an item hides/shows that series and the
	// chart redraws with the value scale recomputed for the remaining series.
	if (showLegend) {
		const isHidden = (s) => hidden.has(nameOf(s));
		const legend = svg.append('g').attr('class', 'cc-legend');
		const items = legend.selectAll('g').data(allSeries).join('g')
			.style('cursor', legendInteractive ? 'pointer' : 'default')
			.style('opacity', (s) => (isHidden(s) ? 0.4 : 1));
		items.append('rect')
			.attr('width', 12).attr('height', 12).attr('rx', 2)
			.attr('y', -legendFontSize + 2)
			.attr('fill', (s) => colorFor(s, s._idx));
		items.append('text')
			.attr('x', 18).attr('y', 0)
			.attr('dominant-baseline', 'middle')
			.attr('fill', axisTextColor)
			.style('font-size', `${legendFontSize}px`)
			.style('text-decoration', (s) => (isHidden(s) ? 'line-through' : 'none'))
			.text((s) => nameOf(s));

		if (legendInteractive) {
			items.on('click', function (event, s) {
				event.stopPropagation(); // don't also fire CHART_CLICKED
				const nm = nameOf(s);
				if (hidden.has(nm)) {
					hidden.delete(nm);
				} else if (allSeries.length - hidden.size > 1) { // keep at least one visible
					hidden.add(nm);
				} else {
					return;
				}
				// redraw with the updated hidden set; animation off so the toggle is instant
				drawChart(container, Object.assign({}, props, { animate: false }), dispatch);
			});
		}

		if (legendPosition === 'right') {
			// vertically center the legend block against the plot area
			const totalH = allSeries.length * legendRowH;
			let yy = margin.top + Math.max(0, (innerH - totalH) / 2);
			items.attr('transform', () => {
				const tr = `translate(${width - margin.right + 12},${yy + legendFontSize})`;
				yy += legendRowH;
				return tr;
			});
		} else {
			// horizontal row, centered under the plot area (not the full svg width,
			// whose unequal left/right margins would push it off-center)
			const widths = allSeriesNames.map(legendItemW);
			const totalW = widths.reduce((a, b) => a + b, 0);
			let xx = Math.max(8, margin.left + innerW / 2 - totalW / 2);
			const yPos = legendPosition === 'top' ? legendFontSize + 4 : bottomCursor + legendFontSize;
			items.attr('transform', (s, i) => {
				const tr = `translate(${xx},${yPos})`;
				xx += widths[i];
				return tr;
			});
		}
	}
}
