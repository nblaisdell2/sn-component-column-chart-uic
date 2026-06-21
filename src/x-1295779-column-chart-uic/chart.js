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
import { easeCubicOut } from 'd3-ease';

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
	const series = Array.isArray(props.series) ? props.series.filter((s) => s && Array.isArray(s.data)) : [];
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
	const dropShadow = props.dropShadow !== false;
	const showGridlines = props.showGridlines !== false;
	const showLegend = props.showLegend !== false && series.length > 0;
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
	const seriesNames = series.map((s, i) => s.name || `Series ${i + 1}`);
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
		else margin.right += Math.min(180, Math.max(...seriesNames.map(legendItemW)) + 8);
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

	// ----- gridlines -----
	// Gridlines run perpendicular to the value axis: horizontal lines for columns,
	// vertical lines for bars (drawn from the bottom value-axis upward across innerH).
	if (showGridlines) {
		const grid = plot.append('g').attr('class', 'cc-grid');
		if (horizontal) {
			grid.attr('transform', `translate(0,${innerH})`)
				.call(axisBottom(y).ticks(yTickCount).tickSize(-innerH).tickFormat(''));
		} else {
			grid.call(axisLeft(y).ticks(yTickCount).tickSize(-innerW).tickFormat(''));
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
			.call(axisBottom(y).ticks(yTickCount).tickFormat(yFmt));
	} else {
		xAxis = plot.append('g')
			.attr('class', 'cc-axis cc-axis-x')
			.attr('transform', `translate(0,${valZero})`)
			.call(axisBottom(x0).tickValues(catTickVals).tickSizeOuter(0));
		yAxis = plot.append('g')
			.attr('class', 'cc-axis cc-axis-y')
			.call(axisLeft(y).ticks(yTickCount).tickFormat(yFmt));
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
				bx = x0(label) + x1(s.name || `Series ${si + 1}`);
				bw = x1.bandwidth();
				y0 = valBase;
				y1 = value;
			}
			bars.push({
				seriesName: seriesNames[si],
				seriesIndex: si,
				label,
				categoryIndex: ci,
				value,
				color: colorFor(s, si),
				bx, bw,
				pyBase: y(y0),
				pyTop: y(y1),
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
		return {
			front: bar3D
				? `M${rx},${ry}h${rw}v${rh}h${-rw}z`
				: roundedRect(rx, ry, rw, rh, d.isTopSegment ? cornerRadius : 0, roundSide),
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
		g.append('path').attr('class', 'cc-face-front').attr('fill', d.color);
		if (bar3D && d.isTopSegment) {
			if (horizontal) g.append('path').attr('class', 'cc-face-side').attr('fill', sideShade(d.color));
			else g.append('path').attr('class', 'cc-face-top').attr('fill', topShade(d.color));
		}
	});

	groups
		.on('mouseenter', function (event, d) {
			if (hoverHighlight) recolorGroup(select(this), hoverFill(d.color));
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
			if (hoverHighlight) recolorGroup(select(this), d.color);
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
	// nothing here can be tree-shaken out of the production bundle).
	const fullH = (d) => Math.abs(d.pyBase - d.pyTop);
	if (animate && typeof requestAnimationFrame === 'function') {
		groups.each(function (d) { paintGroup(select(this), d, 0); });
		const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : new Date().getTime());
		const t0 = now();
		const tick = () => {
			const k = easeCubicOut(Math.min(1, (now() - t0) / animationDuration));
			groups.each(function (d) { paintGroup(select(this), d, fullH(d) * k); });
			if (k < 1) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	} else {
		groups.each(function (d) { paintGroup(select(this), d, fullH(d)); });
	}

	// ----- value labels -----
	if (showValueLabels) {
		const labels = plot.append('g').attr('class', 'cc-value-labels')
			.selectAll('text')
			// skip segments too short to hold the text (incl. ones truncated by the max)
			.data(bars.filter((b) => b.value !== 0 && Math.abs(b.pyBase - b.pyTop) >= labelFontSize + 2))
			.join('text')
			// centered inside each segment's front face so stacked values stay in their own
			// block; the category axis and value axis swap with orientation.
			.attr('x', (d) => (horizontal ? (d.pyBase + d.pyTop) / 2 : d.bx + d.bw / 2))
			.attr('y', (d) => (horizontal ? d.bx + d.bw / 2 : (d.pyBase + d.pyTop) / 2))
			.attr('text-anchor', 'middle')
			.attr('dominant-baseline', 'central')
			.attr('fill', (d) => autoContrast(d.color))
			.style('font-size', `${Math.max(9, labelFontSize - 1)}px`)
			.style('font-weight', '600')
			.style('pointer-events', 'none')
			.style('opacity', animate ? 0 : 1)
			.text((d) => fmt(d.value));
		// fade labels in after the bars finish growing (CSS transition, no d3-transition)
		if (animate && typeof requestAnimationFrame === 'function') {
			labels.style('transition', `opacity 300ms ease ${Math.round(animationDuration * 0.5)}ms`);
			requestAnimationFrame(() => labels.style('opacity', 1));
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
	if (showLegend) {
		const legend = svg.append('g').attr('class', 'cc-legend');
		const items = legend.selectAll('g').data(series).join('g').style('cursor', 'default');
		items.append('rect')
			.attr('width', 12).attr('height', 12).attr('rx', 2)
			.attr('y', -legendFontSize + 2)
			.attr('fill', (s, i) => colorFor(s, i));
		items.append('text')
			.attr('x', 18).attr('y', 0)
			.attr('dominant-baseline', 'middle')
			.attr('fill', axisTextColor)
			.style('font-size', `${legendFontSize}px`)
			.text((s, i) => seriesNames[i]);

		if (legendPosition === 'right') {
			// vertically center the legend block against the plot area
			const totalH = series.length * legendRowH;
			let yy = margin.top + Math.max(0, (innerH - totalH) / 2);
			items.attr('transform', () => {
				const tr = `translate(${width - margin.right + 12},${yy + legendFontSize})`;
				yy += legendRowH;
				return tr;
			});
		} else {
			// horizontal row, centered under the plot area (not the full svg width,
			// whose unequal left/right margins would push it off-center)
			const widths = seriesNames.map(legendItemW);
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
