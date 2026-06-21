import { createCustomElement, actionTypes } from '@servicenow/ui-core';
import snabbdom from '@servicenow/ui-renderer-snabbdom';
import styles from './styles.scss';
import { drawChart } from './chart';
import { SAMPLE_SERIES } from './sampleData';

const { COMPONENT_RENDERED, COMPONENT_DOM_READY, COMPONENT_PROPERTY_CHANGED, COMPONENT_DISCONNECTED } = actionTypes;

/**
 * The view only renders a single stable container. D3 owns everything inside it
 * and is driven imperatively from the lifecycle action handlers below — mixing
 * snabbdom's virtual DOM with D3's direct DOM mutation on the same nodes is what
 * you want to avoid, so we keep them on separate elements.
 */
const view = () => <div className="cc-root" />;

/** Resolve the D3 mount node inside the (open) shadow root. */
const getContainer = (host) =>
	host && host.shadowRoot
		? host.shadowRoot.querySelector('.cc-root') || host.shadowRoot.querySelector('div')
		: null;

/** Coerce a UI Builder value into a CSS length ("50%", "12px"; bare numbers -> px). */
const cssLen = (v, fallback) => {
	if (v === undefined || v === null || v === '') return fallback;
	return /^\d+(\.\d+)?$/.test(String(v)) ? `${v}px` : String(v);
};

/** Render with the sample-data fallback applied when `series` is empty. */
const render = ({ host, properties, dispatch }) => {
	const container = getContainer(host);
	if (!container) return;
	// Configurable outer footprint so the widget need not span the full page width.
	host.style.display = 'block';
	host.style.boxSizing = 'border-box';
	host.style.width = cssLen(properties.componentWidth, '100%');
	host.style.maxWidth = '100%';
	host.style.padding = cssLen(properties.componentPadding, '0');
	// optional widget border (Header & border section)
	const borderW = parseFloat(properties.borderWidth) || 0;
	host.style.border = properties.borderColor && borderW > 0
		? `${borderW}px solid ${properties.borderColor}`
		: 'none';
	host.style.borderRadius = cssLen(properties.borderRadius, '0');
	const series = Array.isArray(properties.series) && properties.series.length
		? properties.series
		: SAMPLE_SERIES;
	const effectiveProps = { ...properties, series };
	// stash latest inputs so the ResizeObserver can redraw on container resize
	host._ccLast = { container, props: effectiveProps, dispatch };
	try {
		drawChart(container, effectiveProps, dispatch);
	} catch (e) {
		// Safety net: surface a render failure instead of failing silently.
		container.textContent = `Chart error: ${e && e.message ? e.message : String(e)}`;
		// eslint-disable-next-line no-console
		if (typeof console !== 'undefined') console.error('[column-chart] render failed', e);
	}
};

createCustomElement('x-1295779-column-chart-uic', {
	renderer: { type: snabbdom },
	view,
	styles,
	properties: {
		series: { default: SAMPLE_SERIES },
		groupMode: { default: 'grouped' },
		orientation: { default: 'vertical' },
		stackOffset: { default: 'none' },
		yScaleType: { default: 'linear' },
		colorScheme: { default: 'custom' },
		xTickRotation: { default: 0 },
		xTickInterval: { default: 1 },
		maxXTicks: { default: 0 },
		componentWidth: { default: '50%' },
		componentPadding: { default: '12px' },
		borderColor: { default: '' },
		borderWidth: { default: 0 },
		borderRadius: { default: 0 },
		chartTitle: { default: 'Tickets by Month' },
		xAxisLabel: { default: '' },
		yAxisLabel: { default: '' },
		showValueLabels: { default: true },
		valueLabelFormat: { default: '' },
		yAxisFormat: { default: '' },
		showTooltip: { default: true },
		tooltipTemplate: { default: '<strong>{label}</strong><br/>{swatch}{seriesName}: {formattedValue}' },
		tooltipFollowCursor: { default: true },
		tooltipBackground: { default: 'rgba(17,24,39,0.92)' },
		tooltipTextColor: { default: '#ffffff' },
		tooltipFontSize: { default: 12 },
		bar3D: { default: true },
		depth3D: { default: 10 },
		colorPalette: { default: ['#2E93fA', '#66DA26', '#546E7A', '#E91E63', '#FF9800', '#9C27B0'] },
		useSeriesColors: { default: true },
		backgroundColor: { default: 'transparent' },
		axisColor: { default: '#6b7280' },
		gridColor: { default: '#e5e7eb' },
		columnPadding: { default: 0.2 },
		groupPadding: { default: 0.05 },
		cornerRadius: { default: 4 },
		yMin: { default: null },
		yMax: { default: null },
		showGridlines: { default: true },
		yTickCount: { default: 5 },
		showLegend: { default: true },
		legendPosition: { default: 'bottom' },
		dropShadow: { default: true },
		shadowColor: { default: 'rgba(0,0,0,0.25)' },
		shadowBlur: { default: 4 },
		hoverHighlight: { default: true },
		hoverColor: { default: '' },
		fontFamily: { default: '' },
		titleFontSize: { default: 18 },
		titleColor: { default: '#374151' },
		axisTextColor: { default: '#6b7280' },
		axisFontSize: { default: 12 },
		axisFontFamily: { default: '' },
		legendFontSize: { default: 12 },
		labelFontSize: { default: 12 },
		animate: { default: true },
		animationDuration: { default: 800 },
		animationEasing: { default: 'cubicOut' },
		animationStagger: { default: 0 },
		barOpacity: { default: 1 },
		minBarHeight: { default: 0 },
		valueLabelPosition: { default: 'inside' },
		showXGridlines: { default: false },
		legendInteractive: { default: false },
		referenceLineValue: { default: '' },
		referenceLineColor: { default: '#ef4444' },
		referenceLineLabel: { default: '' },
		barFillStyle: { default: 'solid' },
		barCornerRadius3D: { default: false },
		hoverDimOthers: { default: false },
		yAxisTickValues: { default: null },
		clampOverflowIndicator: { default: false },
		chartHeight: { default: 360 }
	},
	actionHandlers: {
		// Fires after each (re)render — covers initial paint.
		[COMPONENT_RENDERED]: render,
		// The view is static (doesn't read props), so a property change won't always
		// re-render it. Redraw explicitly when any UI Builder property changes.
		[COMPONENT_PROPERTY_CHANGED]: render,
		// First reliable DOM: wire a ResizeObserver so the chart is responsive to
		// its UI Builder slot without re-animating on every property tweak.
		[COMPONENT_DOM_READY]: (coeffects) => {
			const { host } = coeffects;
			render(coeffects);
			if (typeof ResizeObserver !== 'undefined' && !host._ccResizeObserver) {
				const ro = new ResizeObserver(() => {
					const last = host._ccLast;
					if (last && last.container) {
						drawChart(last.container, { ...last.props, animate: false }, last.dispatch);
					}
				});
				const target = getContainer(host);
				if (target) {
					ro.observe(target);
					host._ccResizeObserver = ro;
				}
			}
		},
		[COMPONENT_DISCONNECTED]: ({ host }) => {
			if (host._ccResizeObserver) {
				host._ccResizeObserver.disconnect();
				host._ccResizeObserver = null;
			}
		}
	}
});
