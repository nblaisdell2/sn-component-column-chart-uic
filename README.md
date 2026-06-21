# D3 Column Chart — UI Builder custom component

A configurable, multi-series **column (bar) chart** for ServiceNow UI Builder, rendered with
[D3.js](https://d3js.org/). The entire look-and-feel is driven by component properties, so
page builders can restyle it from the UI Builder property panel without touching code. It
also emits events you can hook as event handlers (click the chart, click/hover a column to
drill in).

- **Component tag:** `x-1295779-column-chart-uic`
- **Scope:** `x_1295779_column_0`
- **Renderer:** Seismic (`@servicenow/ui-renderer-snabbdom`) + D3 v7

---

## Project layout

```
src/x-1295779-column-chart-uic/
├── index.js        # createCustomElement: properties, view (stable container), lifecycle handlers
├── chart.js        # drawChart(d3, container, props, dispatch) — the D3 rendering
├── sampleData.js   # SAMPLE_SERIES fallback so it renders on drop
├── styles.scss     # host + container sizing, hover/focus affordances
└── __tests__/
now-ui.json         # UI Builder manifest: properties + actions exposed to authors
now-cli.json        # CLI build config
package.json        # deps incl. d3
```

D3 owns the SVG imperatively. The Seismic view renders only a single `.cc-root` div; the
chart is (re)drawn from the `COMPONENT_RENDERED` / `COMPONENT_DOM_READY` lifecycle actions,
and a `ResizeObserver` redraws it when the UI Builder slot resizes. This keeps snabbdom's
virtual DOM and D3's direct DOM mutation on separate elements.

---

## Develop & deploy

> Requires the `snc` CLI with the `ui-component` extension and a configured connection
> profile (`snc configure profile set`).

```powershell
# Local dev harness (hot-reloading), opens example/element.js
snc ui-component develop --open

# Build the deployable update set XML without contacting the instance
snc ui-component generate-update-set --offline

# Build and push the component to the connected instance
snc ui-component deploy
```

After deploying, open **UI Builder → add component → "D3 Column Chart"** (category
*Primitives*). Bind `series` to a data resource (or leave it empty to show sample data),
tune the look-and-feel in the property panel, and wire the events under the component's
**Events** section.

---

## Data shape (`series` property)

```jsonc
[
  { "name": "Submitted", "color": "#2E93fA",
    "data": [ { "label": "Jan", "value": 44 }, { "label": "Feb", "value": 55 } ] },
  { "name": "Resolved",  "color": "#66DA26",
    "data": [ { "label": "Jan", "value": 35 }, { "label": "Feb", "value": 41 } ] }
]
```

Categories (x-axis) come from the first series' `label`s. Leave `series` empty/unbound to
render built-in sample data. Use `groupMode` = `grouped` or `stacked` for multiple series.

---

## Feeding data from the platform

The component keeps the `series` JSON contract above — but you rarely want to hand-write it.
The recommended pattern turns real table data into `series` JSON **on the server** and binds it
straight to *Data · Series data*. All transform logic lives in a reusable **Script Include**
(`server/D3ChartData.js`); a **Transform data resource** calls it and exposes its output to
UI Builder.

```
Table ──GlideAggregate──▶ D3ChartData (Script Include) ──series JSON──▶ Transform data resource
                                                                              │ @data.<name>.output
                                                                              ▼
                                                                    Data · Series data
```

Server-side source files live in **`server/`**:

| File | What it is |
|---|---|
| `server/D3ChartData.js` | Script Include — `fromAggregate()`, `fromRows()`, `fromIndicator()` |
| `server/d3-column-chart-data.transform.js` | Table-aggregate data resource script |
| `server/d3-column-chart-data.properties.json` | Table-aggregate data resource inputs |
| `server/d3-column-chart-data-pa.transform.js` | Performance Analytics data resource script |
| `server/d3-column-chart-data-pa.properties.json` | Performance Analytics data resource inputs |
| `server/sanity-test.background.js` | Verify the table-aggregate transforms |
| `server/sanity-test-pa.background.js` | Verify the PA transform + dump `pa_scores` fields |

### Setup (one time)

1. **Create the Script Include.** *System Definition → Script Includes → New*. Name it
   `D3ChartData`, set **Accessible from = All application scopes**, **Client callable = false**,
   and paste the contents of `server/D3ChartData.js`. Save.
2. **Create the Transform data resource.** Easiest in UI Builder: open your page →
   **Add data resource → Transform** (creates a `sys_ux_data_broker_transform` record).
   - Name it e.g. `D3 Column Chart Data`, leave **Mutates server data** unchecked (read-only).
   - Paste `server/d3-column-chart-data.transform.js` into the **Script** field.
   - Paste the **bare JSON array** from `server/d3-column-chart-data.properties.json` into the
     **Properties** field. It must be just the `[ … ]` array — if the Properties value isn't a valid
     array (e.g. wrapped in an object, or has a `"readOnly": true` entry), the config panel stays
     blank and the **Add** button is disabled when you select the resource.
3. **Create the execute ACL** (required — the resource won't run without it, and UIB does **not**
   always prompt you to create it):
   - Get the data broker's **sys_id**: open your `sys_ux_data_broker_transform` record (filter
     navigator → `sys_ux_data_broker_transform.list` → open it) and copy the sys_id (right-click the
     form header → **Copy sys_id**).
   - **Elevate roles:** profile menu → **Elevate role** → check **security_admin** → **Update**.
   - **System Security → Access Control (ACL) → New**, then set:
     - **Type** = `ux_data_broker`
     - **Operation** = `execute`
     - **Name** = paste the data broker **sys_id** (click the **lock/padlock icon** next to the Name
       field to switch it to a free-text box, then paste)
     - **Active** = true
     - **Grant access:** newer instances use the *Deny-Unless* ACL model and **reject a fully empty
       ACL** ("Empty ACL — Select role or Security Attribute"). Add **one** permissive criterion:
       Security Attribute **`UserIsAuthenticated`** (recommended — any logged-in user), or a role
       like **`snc_internal`**, or check **Advanced** and set Script `answer = gs.isLoggedIn();`.
       (Use a specific role/condition instead to restrict who can run it.)
   - **Submit**, then reload UI Builder — the "ACL failed for databroker" error clears.

### Use it: aggregate a table

Set the data resource inputs, then bind its output to the chart:

- **Bind:** *Data · Series data* → `@data.d3_column_chart_data.output` (use your resource's name).
- **Example — incidents by priority, split by state:**
  `table` = `incident`, `categoryField` = `priority`, `seriesField` = `state`, `metric` = `count`,
  `useDisplayValue` = true. → one series per state, one column per priority.

`fromAggregate(cfg)` options (all also exposed as data-resource inputs):

| Input | Purpose |
|---|---|
| `table` | Table to query (e.g. `incident`) |
| `filter` | Encoded query to scope rows (e.g. `active=true^priority<=2`) |
| `categoryField` | Field for the x-axis categories (group by) |
| `seriesField` | Optional 2nd group → multiple series; blank = one series |
| `metric` | `count` (default) / `sum` / `avg` / `min` / `max` |
| `valueField` | Numeric field to aggregate (required when `metric` ≠ `count`) |
| `seriesName` | Name of the single series when no `seriesField` |
| `useDisplayValue` | Group/label by display value (readable). Default true |
| `colors` | `["#2E93fA","#66DA26"]` (by order) or `{"Resolved":"#66DA26"}` (by series name) |
| `maxCategories` | Keep only the top-N categories by total |
| `sort` | `none` (default) / `label-asc` / `label-desc` / `value-asc` / `value-desc` |

### Use it: reshape rows you already have

If you already have records (e.g. a **Look up records** data resource), call `fromRows` instead
from a Transform that takes the rows as an input:

```js
function transform(input) {
  return new global.D3ChartData().fromRows(input.rows, {
    categoryField: 'month', seriesField: 'team', valueField: 'count'
  });
}
```

### Use it: Performance / Platform Analytics indicators

Chart KPI scores from the **`pa_scores`** table with a **second** Transform data resource
(e.g. `D3 Column Chart Data (PA)`) that calls `D3ChartData.fromIndicator(...)`:

- **Create it** exactly like the first data resource, but paste
  `server/d3-column-chart-data-pa.transform.js` as the **Script** and the bare array from
  `server/d3-column-chart-data-pa.properties.json` as the **Properties**. Create its own
  **execute ACL** (same steps as above — Type `ux_data_broker`, Name = this resource's sys_id).
- **Get sys_ids:** indicator → `pa_indicators.list` (right-click → Copy sys_id); breakdown →
  `pa_breakdowns.list`. (You can also pass an indicator **name** instead of its sys_id.)

Set `mode` plus the relevant inputs, then bind `@data.<pa_resource_name>.output` → *Data · Series data*:

| Mode | Inputs | Result |
|---|---|---|
| `trend` (default) | `indicators` = one or more sys_ids/names, `lastPeriods` = e.g. `12` | One column per collection date; **one series per indicator** |
| `latest` | `indicators` = several sys_ids/names | **One column per indicator** (most recent score), single series |
| `breakdown` | `indicator` = one sys_id/name, `breakdown` = breakdown sys_id | **One column per breakdown element** (latest period) |

**Collected vs Formula/realtime indicators — the `source` input:**

| `source` | Reads from | Use for |
|---|---|---|
| `auto` (default) | `pa_scores`, falling back to the scorecard engine when empty | Anything — figures it out per indicator |
| `scores` | `pa_scores` via GlideRecord | **Collected** indicators (scheduled score collection) |
| `scorecard` | the **PAScorecard** engine (computed live) | **Formula / realtime / Automated** indicators not stored in `pa_scores` |

`step` (e.g. `day`/`week`/`month`) optionally sets the period granularity for scorecard trends.

Notes:
- Multiple indicators in `trend` become separate series (use *Data · Column grouping* = grouped or
  stacked). `colors`, `maxCategories`, and `sort` work the same as the table resource.
- **Formula indicators** are computed at display time and have no stored history, so `trend` may
  return only the current value — **`latest`** is the natural shape for them, and `breakdown` works
  only where the scorecard engine supports it for that indicator type. The running user needs PA
  access to the indicator.
- For **collected** indicators, run `server/sanity-test-pa.background.js` to confirm the scores are
  in `pa_scores` and that the `date`/`value`/`breakdown`/`element` column names match — if your
  instance differs, set the advanced `dateField`/`valueField`/`breakdownField`/`elementField` inputs.
  The same script also probes the `PAScorecard` engine so you can verify the `scorecard` path.

### Dynamic / interactive data (client state)

For data that changes from user interaction (filters, drill-downs):

- **Auto-refresh:** bind the data resource's **inputs** (e.g. `filter`) to **page parameters or
  client state parameters**. When the bound value changes, the data resource re-runs and the chart
  updates — no client script needed.
- **Fully manual:** make `D3ChartData` client-callable (wrap with `AbstractAjaxProcessor`), call it
  from a client script via `GlideAjax`, then `api.setState('seriesData', result)` and bind that
  client state parameter to *Data · Series data*.
- Pair either with the component's **`COLUMN_CLICKED`** event to drill down (e.g. set a parameter
  from the clicked column, which refilters the data resource).

### Verify

Run `server/sanity-test.background.js` in *Scripts - Background* (Global scope). It logs the
`series` JSON from `fromAggregate` (multi- and single-series) and `fromRows` so you can confirm the
shape before wiring it into the page.

> **Note:** these are **platform records** (Script Include / data resource / ACL), not part of the
> component bundle that `snc ui-component deploy` ships. Create them on the instance as above; the
> `server/` files are the version-controlled source. (CLI record creation isn't available on this
> setup, so there's no `snc` command to push them.)

---

## Configure properties

This is the full reference for every property in the component's **Configure** tab in UI
Builder. In the panel, labels are **prefixed by section** (`Header & border · …`,
`Display · …`, etc.) to mimic the native Data Visualization layout — custom components
can't define true collapsible sections, so prefix + ordering is the closest approximation.
Each entry below lists the **panel label**, the underlying property `name` (used for data
bindings/scripting), the default, and how to use it.

> **D3 format specifiers** — several properties accept a
> [d3-format](https://github.com/d3/d3-format#locale_format) string. Common examples:
> `.0f` (whole number `42`), `,.0f` (thousands `1,234`), `.1f` (one decimal `42.5`),
> `$,.0f` (currency `$1,234`), `.0%`/`.2%` (percent `95%` / `95.32%` — note: `0.9532`
> becomes `95.32%`, so use fractions for percent formats), `.2s` (SI `1.2k`). Leave blank
> for the raw number.

### Data

- **Series data** (`series`, default = built-in sample) — The chart data: an array of series, each `{ name, color, data: [ { label, value } ] }`. Bind this to a data resource or edit it inline. Categories (x-axis) come from the **first** series' `label`s; keep labels aligned across series. Leave empty/unbound to render the built-in sample. See [Data shape](#data-shape-series-property).
- **Column grouping** (`groupMode`, default `Grouped`) — Dropdown: **Grouped** (series side by side) or **Stacked** (series stacked into one column per category).
- **Orientation** (`orientation`, default `Vertical`) — Dropdown: **Vertical (columns)** or **Horizontal (bars)**. Horizontal is much better for long category labels. Everything else (3D, stacking, gridlines, labels, tooltip) follows the flip.
- **Stack offset** (`stackOffset`, default `None`) — *Stacked mode only.* **None** = raw totals; **100% (expand)** = every column normalized to full height (the y-axis switches to percent); **Diverging (+/−)** = negatives drop below the zero line and positives rise above it.

### Header & border

- **Title** (`chartTitle`, default `Tickets by Month`) — Heading shown above the chart. Leave blank to hide it.
- **Title font size** (`titleFontSize`, default `18`) — Title size in pixels.
- **Title color** (`titleColor`, default `#374151`) — Title text color (any CSS color).
- **Width** (`componentWidth`, default `50%`) — Outer width of the whole widget so it needn't span the page. Any CSS length (`50%`, `640px`, `40rem`); a bare number is treated as pixels.
- **Padding** (`componentPadding`, default `12px`) — Padding around the whole widget. CSS length; bare number = pixels.
- **Background color** (`backgroundColor`, default `transparent`) — Fill behind the chart. CSS color or `transparent`.
- **Border color** (`borderColor`, default blank) — Widget border color. Leave blank for no border.
- **Border width** (`borderWidth`, default `0`) — Border thickness in pixels. `0` = no border (also requires a border color to show).
- **Border radius** (`borderRadius`, default `0`) — Rounded corners of the widget, in pixels.

### Display

- **Chart height (px)** (`chartHeight`, default `360`) — Height of the chart in pixels. This is the knob for making the chart taller/shorter.
- **Column padding** (`columnPadding`, default `0.2`) — Gap between columns/groups as a fraction of the band width (`0` = touching, `0.9` = thin). Range 0–0.95.
- **Inner group padding (grouped only)** (`groupPadding`, default `0.05`) — In grouped mode, the gap between bars **within** a group, as a fraction (0–0.5). Ignored when stacked.
- **3D columns** (`bar3D`, default `true`) — Render columns as extruded 3D bars (lit top + shaded side). Turn off for flat 2D bars.
- **3D depth (when 3D on)** (`depth3D`, default `10`) — Extrusion depth of the 3D effect, in pixels. Auto-clamped to half the bar width.
- **Corner radius (2D only)** (`cornerRadius`, default `4`) — Rounded corners (at the growing end) of each column, in pixels. Applies in flat (2D) mode, or in 3D when *Rounded corners in 3D* is on.
- **Rounded corners in 3D** (`barCornerRadius3D`, default `false`) — Apply the corner radius to the column fronts even in 3D mode (off = square 3D fronts). Needs *Corner radius* > 0.
- **Bar opacity** (`barOpacity`, default `1`) — Fill opacity of the columns, 0 (transparent) to 1 (solid). Useful for layered/branded looks.
- **Minimum bar size (px)** (`minBarHeight`, default `0`) — Pixel floor so tiny non-zero values stay visible/clickable. Applies to grouped mode; `0` = off.
- **Drop shadow** (`dropShadow`, default `true`) — Apply a soft drop shadow to the columns.
- **Shadow color (when drop shadow on)** (`shadowColor`, default `rgba(0,0,0,0.25)`) — Color of the drop shadow (supports `rgba` for opacity).
- **Shadow blur (when drop shadow on)** (`shadowBlur`, default `4`) — Blur radius of the drop shadow, in pixels.
- **Hover highlight** (`hoverHighlight`, default `true`) — Recolor a column on mouse-over.
- **Hover color (when hover highlight on)** (`hoverColor`, default blank) — Color a column turns on hover. Blank = automatically brighten the column's own color.
- **Dim others on hover** (`hoverDimOthers`, default `false`) — Fade the other columns while hovering one, so the hovered column stands out.
- **Animate** (`animate`, default `true`) — Animate columns growing in on first render and on data change.
- **Animation duration (ms)** (`animationDuration`, default `800`) — Length of the grow-in animation in milliseconds.
- **Animation easing** (`animationEasing`, default `Cubic out`) — Dropdown of d3-ease curves: **Linear, Cubic out, Cubic in-out, Quad out, Exp out, Back out, Bounce out, Elastic out**.
- **Animation stagger (ms)** (`animationStagger`, default `0`) — Delay between categories for a left-to-right cascade. `0` = all bars animate together.
- **Base font family** (`fontFamily`, default blank) — CSS font-family for chart text that doesn't have its own family set (title, legend, data labels). Blank = inherit from the page.

### Colors

- **Use per-series colors** (`useSeriesColors`, default `true`) — Use each series' own `color` field when present; otherwise fall back to the scheme/palette below.
- **Color scheme** (`colorScheme`, default `Custom`) — Pick a built-in D3 categorical scheme — **Category10, Tableau10, Set2, Set3, Paired, Dark2, Pastel1, Accent** — or **Custom** to use the *Color palette*. A scheme only *fills the palette*: explicit per-series colors in the data still win when *Use per-series colors* is on.
- **Color palette** (`colorPalette`, default 6-color set) — JSON array of CSS colors applied per series when *Use per-series colors* is off and *Color scheme* is **Custom**, e.g. `["#2E93fA","#66DA26"]`.
- **Bar fill style** (`barFillStyle`, default `Solid`) — How each bar is filled: **Solid** color, a **Gradient** along the bar's value axis, or a colorblind-friendly **Pattern** (series color plus a per-series texture). Applies to the bar front; 3D side/top stay solid-shaded.

### X-axis

The x-axis is the **category** axis (it swaps to the left side in horizontal orientation).

- **Title** (`xAxisLabel`, default blank) — Caption for the category axis. Blank to hide.
- **Tick label rotation** (`xTickRotation`, default `0`) — Rotate the category tick labels by this many degrees (e.g. `-45`, `-90`) so long/dense labels don't overlap. The chart auto-reserves space for tilted labels.
- **Tick label interval** (`xTickInterval`, default `1`) — Show every Nth category label (`1` = all, `2` = every other, …). Bars are unaffected — only the labels thin out.
- **Max tick labels** (`maxXTicks`, default `0`) — Cap how many category labels show; the chart auto-thins to roughly this many when there are more categories. `0` = no cap.
- **Show gridlines** (`showXGridlines`, default `false`) — Draw gridlines along the category axis (vertical lines for columns, horizontal for bars), in addition to the value-axis gridlines.

### Y-axis

The y-axis is the **value** axis (it swaps to the bottom in horizontal orientation).

- **Title** (`yAxisLabel`, default blank) — Rotated caption beside the value axis. Blank to hide.
- **Scale type** (`yScaleType`, default `Linear`) — **Linear**, **Logarithmic** (for data spanning orders of magnitude; ignores zero/negatives, best with grouped data), or **Square root**.
- **Minimum** (`yMin`, default automatic) — Fixed value-axis minimum. Leave blank for automatic.
- **Maximum** (`yMax`, default automatic) — Fixed value-axis maximum. Leave blank for automatic. Values above it are **truncated** at the top line (see *Mark clipped bars*).
- **Mark clipped bars** (`clampOverflowIndicator`, default `false`) — Draw a small zigzag "torn edge" on bars cut off by an explicit Minimum/Maximum, signaling the value extends beyond the axis.
- **Tick count** (`yTickCount`, default `5`) — Approximate number of ticks/gridlines. Ignored when *Explicit tick values* is set.
- **Explicit tick values** (`yAxisTickValues`, default blank) — JSON array of exact tick values, e.g. `[0, 25, 50, 75, 100]`. Overrides *Tick count*. Blank = automatic.
- **Label format** (`yAxisFormat`, default blank) — D3 format for the **value-axis tick labels only** (independent of the data labels). See the format note above.
- **Show gridlines** (`showGridlines`, default `true`) — Draw gridlines at each value tick (horizontal for columns, vertical for bars).
- **Gridline color** (`gridColor`, default `#e5e7eb`) — Color of the value-axis gridlines (and category gridlines, when on).

### Axes (apply to both x and y)

- **Line color** (`axisColor`, default `#6b7280`) — Color of the axis lines and tick marks (not the text).
- **Text color** (`axisTextColor`, default `#6b7280`) — Color of the axis **tick values and the axis titles**.
- **Font size** (`axisFontSize`, default `12`) — Size (px) of the axis tick values and axis titles.
- **Font family** (`axisFontFamily`, default blank) — Font family for axis text. Blank = use the Base font family.

### Legend

- **Show legend** (`showLegend`, default `true`) — Show a legend of series names with color swatches.
- **Position** (`legendPosition`, default `Bottom`) — Dropdown: **Top**, **Right**, or **Bottom**.
- **Font size** (`legendFontSize`, default `12`) — Size (px) of the legend text.
- **Clickable to toggle series** (`legendInteractive`, default `false`) — Let viewers click a legend item to hide/show that series; the chart rescales to the remaining series. Hidden items stay in the legend (dimmed/struck-through) so they can be toggled back. At least one series always stays visible.

### Data label

- **Show data labels** (`showValueLabels`, default `true`) — Draw each column's numeric value (text color auto-contrasts with the bar).
- **Position** (`valueLabelPosition`, default `Inside`) — Where to draw the labels: **Inside** each bar (centered), **Above / past end** (just beyond the bar's value end), or **None** (hidden).
- **Label format** (`valueLabelFormat`, default blank) — D3 format for the **value labels only** (independent of the y-axis). See the format note above.
- **Font size** (`labelFontSize`, default `12`) — Size (px) of the value labels.

### Reference line

A target/average threshold line drawn across the plot.

- **Value** (`referenceLineValue`, default blank) — Enter a number to draw a line at that value, or **`avg`** (or `mean`) to auto-draw the average of the data. Blank = no line. A value outside the axis range clamps to the edge.
- **Color** (`referenceLineColor`, default `#ef4444`) — Color of the reference line and its label.
- **Label** (`referenceLineLabel`, default blank) — Optional caption drawn at the end of the line.

### Tooltip

A hover tooltip shown when the pointer is over a column.

- **Show tooltip** (`showTooltip`, default `true`) — Enable/disable the hover tooltip.
- **Template** (`tooltipTemplate`, default `<strong>{label}</strong><br/>{swatch}{seriesName}: {formattedValue}`) — Tooltip content. **Light HTML is allowed** in the template; **interpolated values are HTML-escaped**. Supported tokens:
  - `{label}` — category label · `{value}` — raw value · `{formattedValue}` — value via the *Data label · Label format*
  - `{seriesName}`, `{seriesIndex}`, `{categoryIndex}`
  - `{percent}` — the point's value as a percent of its **category total** (great for stacked)
  - `{swatch}` — a small **colored dot** matching the series color (rendered as HTML, not escaped) · `{color}` — the series color string as text
  - **`{anyCustomKey}`** — any extra key you include on a data point. E.g. with
    `data: [{ "label": "Jan", "value": 44, "owner": "Team A" }]`, use `{owner}` in the template.
- **Follow cursor** (`tooltipFollowCursor`, default `true`) — Tooltip tracks the pointer; turn off to anchor it next to the hovered column. Either way it's clamped within the chart bounds.
- **Background color** (`tooltipBackground`, default `rgba(17,24,39,0.92)`) — CSS color (supports rgba).
- **Text color** (`tooltipTextColor`, default `#ffffff`).
- **Font size** (`tooltipFontSize`, default `12`).

> **Note on defaults:** the JSON/auto properties (`series`, `colorPalette`, `yMin`, `yMax`,
> `yAxisTickValues`) have no default shown in the panel — their real defaults live in the
> component code (`src/x-1295779-column-chart-uic/index.js`), because raw arrays/objects
> can't be serialized into the update-set XML. The chart still falls back to sample data and
> automatic axis bounds at runtime.

---

## Events (actions)

| Action | When | Payload |
|---|---|---|
| `CHART_CLICKED` | Click anywhere on the chart (not a column) | `seriesCount`, `categoryCount` |
| `COLUMN_CLICKED` | Click an individual column (drill-in) | `seriesName`, `label`, `value`, `seriesIndex`, `categoryIndex` |
| `COLUMN_HOVERED` | Hover a column | `seriesName`, `label`, `value` |

In UI Builder, add an event handler on (for example) `COLUMN_CLICKED` to navigate, open a
record, or set a page parameter using the payload of the clicked data point.
