/**
 * Script for the "D3 Column Chart Data (PA)" Transform data resource
 * (table: sys_ux_data_broker_transform, "Mutates server data" = false).
 *
 * Turns Performance/Platform Analytics indicator scores (pa_scores) into the
 * component's series JSON. `input` keys are the data resource's Properties
 * (see d3-column-chart-data-pa.properties.json). Bind the output in UI Builder
 * via @data.<data_resource_name>.output to "Data · Series data".
 *
 * Logic lives in the global D3ChartData Script Include (fromIndicator).
 */
function transform(input) {
	return new global.D3ChartData().fromIndicator(input);
}
