// The kinds a table of figures reports (figures.js), how each counts, and the words for each (report.js
// adds FIGURES_TEXT to LOSS_TEXT). A leaf module, so that the report's words need not load the reader.

/** Each kind the figures reader reports: 'loss' (a cell or row not carried), 'warning' (carried, but worth a look) or 'error'. */
export const FIGURES_KINDS = {
  'figures-mapping': 'error',
  'figures-not-csv': 'error',
  'figures-cell-not-number': 'loss',
  'figures-row-no-place': 'loss',
  'figures-duplicate': 'loss',
  'figures-period-invalid': 'warning',
  'figures-period-span': 'warning',
  'figures-no-period': 'warning',
  'figures-names-as-keys': 'warning',
  'figures-total-missing': 'warning',
  'figures-total-unmet': 'warning',
  'figures-mapping-table': 'warning',
  'figures-coordinate-filled': 'warning',
  'figures-code-address': 'warning',
};

export const FIGURES_TEXT = {
  'figures-mapping': 'The description of the table of figures cannot be used as it stands, so nothing is read from it. The example says what is missing or wrong: a table needs a column that is a place (its id, its web address or its name), and at least one column of figures (a "value", or a "figure" with its own coordinates); a total can be only the total of columns of its own measure, each in one total only.',
  'figures-not-csv': 'A table of figures is read from a CSV file or a sheet of a workbook, not from GeoJSON.',
  'figures-cell-not-number': 'A cell in a column of figures is not a number the tools read: a plain number with or without thousands separators (1234, 1,234, 1 234 and 1\'234 are one thousand two hundred and thirty-four), or a dash for a figure the table prints as absent. Words ("About 500"), letters ("12a"), a decimal comma and money are not guessed at, so the figure is left out. The example gives the row, the column and the cell.',
  'figures-row-no-place': 'A row with no place (no id, no web address and no name, whichever the table is read by) cannot say which place its figures are for, so none of them is carried. The example gives the row.',
  'figures-duplicate': 'A row gives a figure for a place, period and coordinates that an earlier row already gave, so it is not carried: two figures with one address would be one figure with two values. The example gives the row, the column and the coordinates.',
  'figures-period-invalid': 'A period that is not a year (1851), an ISO date (1851-03-30), a month or two years (1851-1861) is carried as written (as the period\'s label only), so its figures have no year or day on the Data Cube\'s time axis. The example gives the row and the cell.',
  'figures-period-span': 'A period of more than one year (1851-1861) is carried as the span the table gives, but the Data Cube\'s time axis (sdmx-dimension:refPeriod) holds one year or one day, so these figures have none there and the structure does not declare one. The example gives the first.',
  'figures-no-period': 'Some figures have no period: the table gives none for their row. Their attestations have no date, and the Data Cube cannot place them in time.',
  'figures-names-as-keys': 'No column is the places\' id or web address, so two rows are read as the same place when their names, and the regions mapped as "within", are the same. Two places of one name in one county would become one. Map a column of ids as "id" to be sure.',
  'figures-total-missing': 'A figure that should have a total as its universe (by a column\'s "totalOf", or by the code marked as the total of a dimension) has none in the table: the figure of that total is not there, so no universe is written for it. Nothing is guessed in its place. The example gives the row, the column and the total looked for.',
  'figures-total-unmet': 'A code marked as the total of a dimension never occurs in that dimension, so it is the total of nothing. Check its spelling against the table\'s cells. The example gives the dimension and the code.',
  'figures-mapping-table': 'Part of the table\'s description is not used: a key the reader does not know, or one given wrongly. The example says which.',
  'figures-coordinate-filled': 'The columns of one measure do not all have the same dimensions, so a figure lacking one is given the dimension\'s "unknown" code, as a blank cell is: the Data Cube needs every figure of a table to have a value for every dimension. The example gives the measure and the dimension.',
  'figures-code-address': 'A code given for a dimension\'s value in the table\'s description is not a web address, so it is not used and the code is made under the base address like any other.',
};

/** The counts a table of figures keeps, in the order they are added up: every cell of a column of figures is one of the last four. */
export const FIGURE_COUNTS = ['figure cells', 'figures', 'declared absences', 'blank cells', 'cells left out'];

/**
 * The conservation line of a run: every cell in a column of figures is a figure written, a printed
 * dash written as a declared absence, a blank (no figure), or reported and left out. Null when the
 * run read no figures. The denominator travels with the number.
 */
export function conservation(c) {
  const cells = c['figure cells'];
  if (!cells) return null;
  const n = (x) => (x || 0).toLocaleString('en-GB');
  const parts = [`${n(c.figures)} ${c.figures === 1 ? 'figure' : 'figures'}`, `${n(c['declared absences'])} printed ${c['declared absences'] === 1 ? 'dash' : 'dashes'}`, `${n(c['blank cells'])} blank`, `${n(c['cells left out'])} left out`];
  return `${n(cells)} ${cells === 1 ? 'cell' : 'cells'} of figures: ${parts.join(', ')}.`;
}
