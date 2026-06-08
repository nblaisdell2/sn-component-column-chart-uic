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

### Data

- **Series data** (`series`, default = built-in sample) — The chart data: an array of series, each `{ name, color, data: [ { label, value } ] }`. Bind this to a data resource or edit it inline. Categories (x-axis) come from the **first** series' `label`s; keep labels aligned across series. Leave empty/unbound to render the built-in sample. See [Data shape](#data-shape-series-property).
- **Column grouping** (`groupMode`, default `Grouped`) — Dropdown: **Grouped** (series side by side) or **Stacked** (series stacked into one column per category).

### Display

- **Chart height (px)** (`chartHeight`, default `360`) — Height of the chart in pixels. This is the knob for making the chart taller/shorter.
- **Column padding** (`columnPadding`, default `0.2`) — Gap between columns/groups as a fraction of the band width (`0` = touching, `0.9` = thin). Range 0–0.95.
- **Inner group padding (grouped only)** (`groupPadding`, default `0.05`) — In grouped mode, the gap between bars **within** a group, as a fraction (0–0.5). Ignored when stacked.
- **Corner radius (2D only)** (`cornerRadius`, default `4`) — Rounded top corners of each column, in pixels. Applies only when 3D columns is **off**.
- **3D columns** (`bar3D`, default `true`) — Render columns as extruded 3D bars (lit top + shaded side). Turn off for flat 2D bars.
- **3D depth (when 3D on)** (`depth3D`, default `10`) — Extrusion depth of the 3D effect, in pixels. Auto-clamped to half the bar width.
- **Animate** (`animate`, default `true`) — Animate columns growing in on first render and on data change.
- **Animation duration (ms)** (`animationDuration`, default `800`) — Length of the grow-in animation in milliseconds.
- **Drop shadow** (`dropShadow`, default `true`) — Apply a soft drop shadow to the columns.
- **Shadow color (when drop shadow on)** (`shadowColor`, default `rgba(0,0,0,0.25)`) — Color of the drop shadow (supports `rgba` for opacity).
- **Shadow blur (when drop shadow on)** (`shadowBlur`, default `4`) — Blur radius of the drop shadow, in pixels.
- **Hover highlight** (`hoverHighlight`, default `true`) — Recolor a column on mouse-over.
- **Hover color (when hover highlight on)** (`hoverColor`, default blank) — Color a column turns on hover. Blank = automatically brighten the column's own color.
- **Base font family** (`fontFamily`, default blank) — CSS font-family for chart text that doesn't have its own family set (title, legend, data labels). Blank = inherit from the page.

### Y-axis

- **Title** (`yAxisLabel`, default blank) — Rotated caption beside the y-axis. Blank to hide.
- **Minimum** (`yMin`, default automatic) — Fixed y-axis minimum. Leave blank for automatic.
- **Maximum** (`yMax`, default automatic) — Fixed y-axis maximum. Leave blank for automatic. Values above it are **truncated** at the top line.
- **Tick count** (`yTickCount`, default `5`) — Approximate number of ticks/gridlines on the y-axis.
- **Label format** (`yAxisFormat`, default blank) — D3 format for the **y-axis tick labels only** (independent of the data labels). See the format note above.
- **Show gridlines** (`showGridlines`, default `true`) — Draw horizontal gridlines at each y tick.
- **Gridline color** (`gridColor`, default `#e5e7eb`) — Color of the horizontal gridlines.

### X-axis

- **Title** (`xAxisLabel`, default blank) — Caption beneath the x-axis. Blank to hide.

### Axes (apply to both x and y)

- **Line color** (`axisColor`, default `#6b7280`) — Color of the axis lines and tick marks (not the text).
- **Text color** (`axisTextColor`, default `#6b7280`) — Color of the axis **tick values and the axis titles**.
- **Font size** (`axisFontSize`, default `12`) — Size (px) of the axis tick values and axis titles.
- **Font family** (`axisFontFamily`, default blank) — Font family for axis text. Blank = use the Base font family.

### Legend

- **Show legend** (`showLegend`, default `true`) — Show a legend of series names with color swatches.
- **Position** (`legendPosition`, default `Bottom`) — Dropdown: **Top**, **Right**, or **Bottom**.
- **Font size** (`legendFontSize`, default `12`) — Size (px) of the legend text.

### Data label

- **Show data labels** (`showValueLabels`, default `true`) — Draw each column's numeric value inside the bar (centered; text color auto-contrasts with the bar).
- **Label format** (`valueLabelFormat`, default blank) — D3 format for the **in-bar value labels only** (independent of the y-axis). See the format note above.
- **Font size** (`labelFontSize`, default `12`) — Size (px) of the in-bar value labels.

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
- **Follow cursor** (`tooltipFollowCursor`, default `true`) — Tooltip tracks the pointer; turn off to anchor it above the hovered column. Either way it's clamped within the chart bounds.
- **Background color** (`tooltipBackground`, default `rgba(17,24,39,0.92)`) — CSS color (supports rgba).
- **Text color** (`tooltipTextColor`, default `#ffffff`).
- **Font size** (`tooltipFontSize`, default `12`).

### Colors

- **Use per-series colors** (`useSeriesColors`, default `true`) — Use each series' own `color` field when present; otherwise fall back to the palette below.
- **Color palette** (`colorPalette`, default 6-color set) — JSON array of CSS colors applied per series when *Use per-series colors* is off, e.g. `["#2E93fA","#66DA26"]`.

> **Note on defaults:** the JSON/auto properties (`series`, `colorPalette`, `yMin`, `yMax`)
> have no default shown in the panel — their real defaults live in the component code
> (`src/x-1295779-column-chart-uic/index.js`), because raw arrays/objects can't be
> serialized into the update-set XML. The chart still falls back to sample data and
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
