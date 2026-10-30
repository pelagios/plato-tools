# Tables of figures for the figures reader

Every file here is constructed for the tests: invented places, invented numbers, no third-party data
and so no licence beyond the repository's. (Real census tables, such as SN 4559, are CC BY-SA 4.0 and
are not in the repository; a pass against them, if made, is local and uncommitted.) The tests are
`test/figures-*.test.js`.

| File | Exercises |
|---|---|
| `example-statistics.csv` + `.columns.json` | The oracle: PLATO's own statistics example (`schemas/examples/place-centric-statistics.json`) as a table. Read with its saved description, the reader gives that example's figures, structure and universes, modulo addresses. |
| `long-shape.csv`, `wide-shape.csv` | The same six figures in the two shapes the reader takes; the two must give the same cube. The wide table marks its total with `totalOf`, the long one with the dimension's `total`. |
| `dashes-and-blanks.csv` | A printed dash of each kind (`-`, `–`, `—`) is a declared absence; a blank is no figure; `0` is 0; `1,234` is 1234; `About 500`, `12a` and `1,5` are reported and left out. Ten cells: 3 figures, 3 dashes, 1 blank, 3 left out. |
| `repeated-names.csv` | Two parishes called Newport. With the county mapped as a region they are two places; without it they are one place, and the second row's figure is a duplicate. |
| `period-forms.csv` | A year, a day, a span, words and a blank as the period. |
| `bad-cells.csv` | A repeated heading, a row with no place, an empty line, a cell that is not a number. |
| `totals-wrong.csv` | Parts that do not add up to the printed total. The reader carries the universe as marked and does not judge the sum. |
| `two-measures.csv` | Two measures in one table become two data sets. |
