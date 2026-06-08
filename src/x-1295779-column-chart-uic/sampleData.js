/**
 * Built-in sample data so the component renders something meaningful the moment
 * it is dropped onto a page, before the author binds the `series` property to a
 * real data resource. Mirrors the `series` defaultValue in now-ui.json.
 *
 * Shape: Array<{ name: string, color?: string, data: Array<{ label, value }> }>
 */
export const SAMPLE_SERIES = [
	{
		name: 'Submitted',
		color: '#2E93fA',
		data: [
			{ label: 'Jan', value: 44 },
			{ label: 'Feb', value: 55 },
			{ label: 'Mar', value: 41 },
			{ label: 'Apr', value: 67 },
			{ label: 'May', value: 22 },
			{ label: 'Jun', value: 43 }
		]
	},
	{
		name: 'Resolved',
		color: '#66DA26',
		data: [
			{ label: 'Jan', value: 35 },
			{ label: 'Feb', value: 41 },
			{ label: 'Mar', value: 36 },
			{ label: 'Apr', value: 50 },
			{ label: 'May', value: 18 },
			{ label: 'Jun', value: 39 }
		]
	}
];
