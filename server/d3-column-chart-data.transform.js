/**
 * Script for the "D3 Column Chart Data" Transform data resource
 * (table: sys_ux_data_broker_transform, "Mutates server data" = false).
 *
 * Paste this into the data resource's Script field. `input` is an object whose
 * keys are the data resource's Properties (see d3-column-chart-data.properties.json).
 * The returned value is the data resource output, bound in UI Builder via
 *   @data.<data_resource_name>.output
 * to the component's "Data · Series data" property.
 *
 * All heavy lifting lives in the global D3ChartData Script Include so the logic
 * is reusable (data resource here, GlideAjax/client scripts elsewhere).
 */
function transform(input) {
	return new global.D3ChartData().fromAggregate(input);
}
