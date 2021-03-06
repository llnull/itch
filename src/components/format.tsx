import * as React from "react";
import { FormattedMessage, InjectedIntl } from "react-intl";

export default function format(input: any): JSX.Element | string {
  if (Array.isArray(input)) {
    const id = input[0];
    const valuesIn = input[1] || {};
    const { defaultValue = null, ...values } = valuesIn;
    return (
      <FormattedMessage id={id} values={values} defaultMessage={defaultValue} />
    );
  } else {
    return input;
  }
}

export function formatString(intl: InjectedIntl, input: any): string {
  if (Array.isArray(input)) {
    return intl.formatMessage({ id: input[0] }, input[1]);
  } else {
    return input;
  }
}
