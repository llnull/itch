import { Model, Column } from "./model";

import { fromJSONField } from "./json-field";
import { fromDateTimeField } from "./datetime-field";

export default function expandFields(input: any, model: Model) {
  if (!input) {
    return;
  }

  for (const key of Object.keys(model.columns)) {
    const colType = model.columns[key];
    if (colType === Column.Boolean) {
      input[key] = input[key] === 1;
    } else if (colType === Column.JSON) {
      input[key] = fromJSONField(input[key]);
    } else if (colType === Column.DateTime) {
      input[key] = fromDateTimeField(input[key]);
    }
  }
}
