// What each function takes and does, for the formula editor's suggestions and hints.
// One line per function: NAME|category|arguments|what it does.
const TABLE = `
SUM|Math|number1, [number2], …|Adds numbers.
SUMIF|Math|range, criteria, [sum_range]|Adds the cells that meet a condition.
SUMIFS|Math|sum_range, criteria_range1, criteria1, …|Adds the cells that meet several conditions.
SUMPRODUCT|Math|array1, [array2], …|Multiplies arrays item by item and adds the products.
SUMSQ|Math|number1, [number2], …|Adds the squares of numbers.
PRODUCT|Math|number1, [number2], …|Multiplies numbers.
ABS|Math|number|The number without its sign.
ROUND|Math|number, num_digits|Rounds to a number of digits.
ROUNDUP|Math|number, num_digits|Rounds away from zero.
ROUNDDOWN|Math|number, num_digits|Rounds toward zero.
MROUND|Math|number, multiple|Rounds to the nearest multiple.
CEILING|Math|number, significance|Rounds up to a multiple.
CEILING.MATH|Math|number, [significance], [mode]|Rounds up to a multiple.
FLOOR|Math|number, significance|Rounds down to a multiple.
FLOOR.MATH|Math|number, [significance], [mode]|Rounds down to a multiple.
INT|Math|number|Rounds down to a whole number.
TRUNC|Math|number, [num_digits]|Cuts off the decimals.
MOD|Math|number, divisor|The remainder after dividing.
QUOTIENT|Math|numerator, denominator|The whole part of a division.
POWER|Math|number, power|A number raised to a power.
SQRT|Math|number|The square root.
EXP|Math|number|e raised to a power.
LN|Math|number|The natural logarithm.
LOG|Math|number, [base]|The logarithm in a base (10 when left out).
LOG10|Math|number|The base-10 logarithm.
PI|Math||The number π.
SIGN|Math|number|1, 0 or -1 for the sign.
RAND|Math||A random number from 0 to 1.
RANDBETWEEN|Math|bottom, top|A random whole number between two numbers.
RANDARRAY|Math|[rows], [columns], [min], [max], [whole_number]|An array of random numbers.
SEQUENCE|Math|rows, [columns], [start], [step]|An array of numbers in sequence.
FACT|Math|number|The factorial.
COMBIN|Math|number, number_chosen|The number of combinations.
PERMUT|Math|number, number_chosen|The number of permutations.
GCD|Math|number1, [number2], …|The greatest common divisor.
LCM|Math|number1, [number2], …|The least common multiple.
EVEN|Math|number|Rounds up to an even number.
ODD|Math|number|Rounds up to an odd number.
SUBTOTAL|Math|function_num, ref1, …|A subtotal (SUM, AVERAGE, COUNT…) that skips other subtotals.
AGGREGATE|Math|function_num, options, ref1, …|A subtotal that can skip errors and hidden rows.
MMULT|Math|array1, array2|The matrix product.
MDETERM|Math|array|The determinant of a matrix.
MINVERSE|Math|array|The inverse of a matrix.
MUNIT|Math|dimension|The identity matrix.
SIN|Math|number|The sine of an angle in radians.
COS|Math|number|The cosine.
TAN|Math|number|The tangent.
ASIN|Math|number|The arcsine.
ACOS|Math|number|The arccosine.
ATAN|Math|number|The arctangent.
ATAN2|Math|x_num, y_num|The arctangent of x and y.
DEGREES|Math|angle|Radians to degrees.
RADIANS|Math|angle|Degrees to radians.
ROMAN|Math|number, [form]|A number as Roman numerals.
ARABIC|Math|text|Roman numerals as a number.
BASE|Math|number, radix, [min_length]|A number as text in a base.
DECIMAL|Math|text, radix|Text in a base as a number.
DEC2BIN|Engineering|number, [places]|Decimal to binary.
DEC2HEX|Engineering|number, [places]|Decimal to hexadecimal.
DEC2OCT|Engineering|number, [places]|Decimal to octal.
BIN2DEC|Engineering|number|Binary to decimal.
HEX2DEC|Engineering|number|Hexadecimal to decimal.
OCT2DEC|Engineering|number|Octal to decimal.
AVERAGE|Statistical|number1, [number2], …|The mean.
AVERAGEA|Statistical|value1, [value2], …|The mean, counting text as 0 and TRUE as 1.
AVERAGEIF|Statistical|range, criteria, [average_range]|The mean of the cells that meet a condition.
AVERAGEIFS|Statistical|average_range, criteria_range1, criteria1, …|The mean of the cells that meet several conditions.
COUNT|Statistical|value1, [value2], …|Counts numbers.
COUNTA|Statistical|value1, [value2], …|Counts cells that are not empty.
COUNTBLANK|Statistical|range|Counts empty cells.
COUNTIF|Statistical|range, criteria|Counts the cells that meet a condition.
COUNTIFS|Statistical|criteria_range1, criteria1, …|Counts the cells that meet several conditions.
MAX|Statistical|number1, [number2], …|The largest number.
MAXIFS|Statistical|max_range, criteria_range1, criteria1, …|The largest number that meets conditions.
MIN|Statistical|number1, [number2], …|The smallest number.
MINIFS|Statistical|min_range, criteria_range1, criteria1, …|The smallest number that meets conditions.
MEDIAN|Statistical|number1, [number2], …|The middle number.
MODE.SNGL|Statistical|number1, [number2], …|The most common number.
MODE.MULT|Statistical|number1, [number2], …|The most common numbers, as an array.
STDEV.S|Statistical|number1, [number2], …|The standard deviation of a sample.
STDEV.P|Statistical|number1, [number2], …|The standard deviation of a whole population.
VAR.S|Statistical|number1, [number2], …|The variance of a sample.
VAR.P|Statistical|number1, [number2], …|The variance of a whole population.
LARGE|Statistical|array, k|The k-th largest number.
SMALL|Statistical|array, k|The k-th smallest number.
RANK.EQ|Statistical|number, ref, [order]|The rank of a number in a list.
RANK.AVG|Statistical|number, ref, [order]|The rank, averaged for ties.
PERCENTILE.INC|Statistical|array, k|The k-th percentile (0 to 1).
PERCENTILE.EXC|Statistical|array, k|The k-th percentile, excluding 0 and 1.
QUARTILE.INC|Statistical|array, quart|A quartile (0 to 4).
PERCENTRANK.INC|Statistical|array, x, [significance]|The rank of x as a percentage.
CORREL|Statistical|array1, array2|The correlation coefficient.
COVARIANCE.S|Statistical|array1, array2|The sample covariance.
SLOPE|Statistical|known_ys, known_xs|The slope of the regression line.
INTERCEPT|Statistical|known_ys, known_xs|Where the regression line crosses the y axis.
RSQ|Statistical|known_ys, known_xs|R squared of the regression.
FORECAST.LINEAR|Statistical|x, known_ys, known_xs|A value on the regression line.
TREND|Statistical|known_ys, [known_xs], [new_xs]|Values on the regression line.
GROWTH|Statistical|known_ys, [known_xs], [new_xs]|Values on an exponential trend.
LINEST|Statistical|known_ys, [known_xs], [const]|The slope and intercept of the regression line.
FREQUENCY|Statistical|data_array, bins_array|How many values fall in each bin.
GEOMEAN|Statistical|number1, [number2], …|The geometric mean.
HARMEAN|Statistical|number1, [number2], …|The harmonic mean.
TRIMMEAN|Statistical|array, percent|The mean without the top and bottom values.
NORM.DIST|Statistical|x, mean, standard_dev, cumulative|The normal distribution.
NORM.INV|Statistical|probability, mean, standard_dev|The inverse of the normal distribution.
NORM.S.DIST|Statistical|z, cumulative|The standard normal distribution.
NORM.S.INV|Statistical|probability|The inverse of the standard normal distribution.
T.DIST|Statistical|x, deg_freedom, cumulative|Student's t distribution.
T.INV.2T|Statistical|probability, deg_freedom|The two-tailed inverse of the t distribution.
T.TEST|Statistical|array1, array2, tails, type|The probability from a t-test.
CHISQ.DIST.RT|Statistical|x, deg_freedom|The right tail of the chi-squared distribution.
CHISQ.TEST|Statistical|actual_range, expected_range|The chi-squared test of independence.
BINOM.DIST|Statistical|number_s, trials, probability_s, cumulative|The binomial distribution.
POISSON.DIST|Statistical|x, mean, cumulative|The Poisson distribution.
EXPON.DIST|Statistical|x, lambda, cumulative|The exponential distribution.
F.DIST.RT|Statistical|x, deg_freedom1, deg_freedom2|The right tail of the F distribution.
CONFIDENCE.NORM|Statistical|alpha, standard_dev, size|The confidence interval for a mean.
STANDARDIZE|Statistical|x, mean, standard_dev|A normalized value.
IF|Logical|logical_test, [value_if_true], [value_if_false]|One value if a condition is true, another if not.
IFS|Logical|logical_test1, value_if_true1, …|The value for the first condition that is true.
IFERROR|Logical|value, value_if_error|A value, or another one when it is an error.
IFNA|Logical|value, value_if_na|A value, or another one when it is #N/A.
SWITCH|Logical|expression, value1, result1, …, [default]|The result for the value that matches.
AND|Logical|logical1, [logical2], …|TRUE when every condition is true.
OR|Logical|logical1, [logical2], …|TRUE when any condition is true.
XOR|Logical|logical1, [logical2], …|TRUE when an odd number of conditions are true.
NOT|Logical|logical|The opposite of a condition.
LET|Logical|name1, value1, …, calculation|Names values to use in a calculation.
LAMBDA|Logical|[parameter1], …, calculation|A function of your own.
MAP|Logical|array1, …, lambda|Applies a LAMBDA to every value.
REDUCE|Logical|initial_value, array, lambda|Folds an array into one value with a LAMBDA.
SCAN|Logical|initial_value, array, lambda|Every step of a REDUCE.
BYROW|Logical|array, lambda|A LAMBDA applied to each row.
BYCOL|Logical|array, lambda|A LAMBDA applied to each column.
MAKEARRAY|Logical|rows, columns, lambda|An array made by a LAMBDA.
CHOOSE|Lookup|index_num, value1, [value2], …|The value at a position in a list.
VLOOKUP|Lookup|lookup_value, table_array, col_index_num, [range_lookup]|Finds a value in the first column and returns one from its row.
HLOOKUP|Lookup|lookup_value, table_array, row_index_num, [range_lookup]|Finds a value in the first row and returns one from its column.
XLOOKUP|Lookup|lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode]|Finds a value and returns the matching item.
LOOKUP|Lookup|lookup_value, lookup_vector, [result_vector]|Finds a value in sorted data.
MATCH|Lookup|lookup_value, lookup_array, [match_type]|The position of a value in a list.
XMATCH|Lookup|lookup_value, lookup_array, [match_mode], [search_mode]|The position of a value, with more ways to match.
INDEX|Lookup|array, row_num, [column_num]|The value at a row and column.
OFFSET|Lookup|reference, rows, cols, [height], [width]|A reference moved from another.
INDIRECT|Lookup|ref_text, [a1]|The reference written in a text.
ADDRESS|Lookup|row_num, column_num, [abs_num], [a1], [sheet_text]|A cell address as text.
ROW|Lookup|[reference]|The row number.
ROWS|Lookup|array|How many rows.
COLUMN|Lookup|[reference]|The column number.
COLUMNS|Lookup|array|How many columns.
TRANSPOSE|Lookup|array|Turns rows into columns.
FILTER|Lookup|array, include, [if_empty]|The rows that meet a condition.
SORT|Lookup|array, [sort_index], [sort_order], [by_col]|Sorts an array.
SORTBY|Lookup|array, by_array1, [sort_order1], …|Sorts by other arrays.
UNIQUE|Lookup|array, [by_col], [exactly_once]|The distinct values.
VSTACK|Lookup|array1, [array2], …|Stacks arrays on top of each other.
HSTACK|Lookup|array1, [array2], …|Puts arrays side by side.
TAKE|Lookup|array, rows, [columns]|The first (or last) rows and columns.
DROP|Lookup|array, rows, [columns]|Without the first (or last) rows and columns.
CHOOSEROWS|Lookup|array, row_num1, …|Chosen rows.
CHOOSECOLS|Lookup|array, col_num1, …|Chosen columns.
TOCOL|Lookup|array, [ignore], [scan_by_column]|An array as one column.
TOROW|Lookup|array, [ignore], [scan_by_column]|An array as one row.
WRAPROWS|Lookup|vector, wrap_count, [pad_with]|A row or column wrapped into rows.
WRAPCOLS|Lookup|vector, wrap_count, [pad_with]|A row or column wrapped into columns.
EXPAND|Lookup|array, rows, [columns], [pad_with]|An array made bigger.
GROUPBY|Lookup|row_fields, values, function, …|Groups rows and summarizes their values.
HYPERLINK|Lookup|link_location, [friendly_name]|A link.
LEN|Text|text|How many characters.
LEFT|Text|text, [num_chars]|The first characters.
RIGHT|Text|text, [num_chars]|The last characters.
MID|Text|text, start_num, num_chars|Characters from the middle.
LOWER|Text|text|Lower case.
UPPER|Text|text|Upper case.
PROPER|Text|text|Each word with a capital letter.
TRIM|Text|text|Without extra spaces.
CLEAN|Text|text|Without characters that do not print.
CONCAT|Text|text1, [text2], …|Joins texts and ranges.
CONCATENATE|Text|text1, [text2], …|Joins texts.
TEXTJOIN|Text|delimiter, ignore_empty, text1, …|Joins texts with a separator.
SUBSTITUTE|Text|text, old_text, new_text, [instance_num]|Replaces text by matching it.
REPLACE|Text|old_text, start_num, num_chars, new_text|Replaces characters at a position.
FIND|Text|find_text, within_text, [start_num]|Where a text starts (case-sensitive).
SEARCH|Text|find_text, within_text, [start_num]|Where a text starts (any case, wildcards).
TEXT|Text|value, format_text|A value as text in a number format.
VALUE|Text|text|Text as a number.
NUMBERVALUE|Text|text, [decimal_separator], [group_separator]|Text as a number, in any locale.
FIXED|Text|number, [decimals], [no_commas]|A number as text with fixed decimals.
DOLLAR|Text|number, [decimals]|A number as currency text.
REPT|Text|text, number_times|Repeats a text.
EXACT|Text|text1, text2|TRUE when two texts are exactly the same.
CHAR|Text|number|The character for a code.
CODE|Text|text|The code of the first character.
UNICHAR|Text|number|The Unicode character for a number.
UNICODE|Text|text|The Unicode number of the first character.
TEXTBEFORE|Text|text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found]|The text before a delimiter.
TEXTAFTER|Text|text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found]|The text after a delimiter.
TEXTSPLIT|Text|text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with]|Splits text into columns and rows.
VALUETOTEXT|Text|value, [format]|A value as text.
REGEXTEST|Text|text, pattern, [case_sensitivity]|TRUE when a pattern matches.
REGEXEXTRACT|Text|text, pattern, [return_mode], [case_sensitivity]|The text a pattern matches.
REGEXREPLACE|Text|text, pattern, replacement, [occurrence], [case_sensitivity]|Replaces what a pattern matches.
DATE|Date|year, month, day|A date.
TIME|Date|hour, minute, second|A time.
TODAY|Date||Today's date.
NOW|Date||The date and time now.
YEAR|Date|serial_number|The year of a date.
MONTH|Date|serial_number|The month of a date.
DAY|Date|serial_number|The day of a date.
HOUR|Date|serial_number|The hour of a time.
MINUTE|Date|serial_number|The minute of a time.
SECOND|Date|serial_number|The second of a time.
WEEKDAY|Date|serial_number, [return_type]|The day of the week as a number.
WEEKNUM|Date|serial_number, [return_type]|The week number in the year.
ISOWEEKNUM|Date|date|The ISO week number.
EDATE|Date|start_date, months|A date some months before or after.
EOMONTH|Date|start_date, months|The last day of a month.
DATEDIF|Date|start_date, end_date, unit|Days, months or years between dates.
DAYS|Date|end_date, start_date|Days between two dates.
DAYS360|Date|start_date, end_date, [method]|Days between dates in a 360-day year.
DATEVALUE|Date|date_text|Text as a date.
TIMEVALUE|Date|time_text|Text as a time.
NETWORKDAYS|Date|start_date, end_date, [holidays]|Working days between two dates.
NETWORKDAYS.INTL|Date|start_date, end_date, [weekend], [holidays]|Working days, with your own weekend.
WORKDAY|Date|start_date, days, [holidays]|A date some working days away.
WORKDAY.INTL|Date|start_date, days, [weekend], [holidays]|A date some working days away, with your own weekend.
YEARFRAC|Date|start_date, end_date, [basis]|The fraction of a year between dates.
PMT|Financial|rate, nper, pv, [fv], [type]|The payment for a loan.
PV|Financial|rate, nper, pmt, [fv], [type]|The present value.
FV|Financial|rate, nper, pmt, [pv], [type]|The future value.
NPER|Financial|rate, pmt, pv, [fv], [type]|The number of periods.
RATE|Financial|nper, pmt, pv, [fv], [type], [guess]|The interest rate per period.
IPMT|Financial|rate, per, nper, pv, [fv], [type]|The interest part of a payment.
PPMT|Financial|rate, per, nper, pv, [fv], [type]|The principal part of a payment.
CUMIPMT|Financial|rate, nper, pv, start_period, end_period, type|Interest paid between two periods.
CUMPRINC|Financial|rate, nper, pv, start_period, end_period, type|Principal paid between two periods.
NPV|Financial|rate, value1, [value2], …|The net present value.
XNPV|Financial|rate, values, dates|The net present value of dated cash flows.
IRR|Financial|values, [guess]|The internal rate of return.
XIRR|Financial|values, dates, [guess]|The internal rate of return of dated cash flows.
MIRR|Financial|values, finance_rate, reinvest_rate|The modified internal rate of return.
SLN|Financial|cost, salvage, life|Straight-line depreciation.
DDB|Financial|cost, salvage, life, period, [factor]|Double-declining balance depreciation.
DB|Financial|cost, salvage, life, period, [month]|Fixed-declining balance depreciation.
SYD|Financial|cost, salvage, life, per|Sum-of-years' digits depreciation.
EFFECT|Financial|nominal_rate, npery|The effective annual rate.
NOMINAL|Financial|effect_rate, npery|The nominal annual rate.
ISBLANK|Information|value|TRUE when a cell is empty.
ISNUMBER|Information|value|TRUE for a number.
ISTEXT|Information|value|TRUE for text.
ISLOGICAL|Information|value|TRUE for TRUE or FALSE.
ISERROR|Information|value|TRUE for any error.
ISERR|Information|value|TRUE for an error other than #N/A.
ISNA|Information|value|TRUE for #N/A.
ISEVEN|Information|number|TRUE for an even number.
ISODD|Information|number|TRUE for an odd number.
ISFORMULA|Information|reference|TRUE when a cell has a formula.
ISREF|Information|value|TRUE for a reference.
FORMULATEXT|Information|reference|A cell's formula as text.
TYPE|Information|value|The type of a value as a number.
ERROR.TYPE|Information|error_val|The number of an error.
NA|Information||The #N/A error.
N|Information|value|A value as a number.
T|Information|value|A value if it is text, otherwise "".
SHEET|Information|[value]|The sheet's number.
SHEETS|Information|[reference]|How many sheets.
CELL|Information|info_type, [reference]|Information about a cell.
`;

export interface FunctionHelp {
  name: string;
  category: string;
  args: string;
  about: string;
}

export const HELP = new Map<string, FunctionHelp>();
for (const line of TABLE.trim().split("\n")) {
  const [name, category, args, about] = line.split("|");
  HELP.set(name!, { name: name!, category: category!, args: args ?? "", about: about ?? "" });
}

export function helpFor(name: string): FunctionHelp {
  return HELP.get(name) ?? { name, category: "Other", args: "…", about: "" };
}
