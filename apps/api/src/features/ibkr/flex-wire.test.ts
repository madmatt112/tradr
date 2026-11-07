// Red-first (task 8): `flex-wire.ts` does not exist yet. This file fixes the
// contract the implementer builds to for design C3's two pure functions.
//
// `classifyFlexBody(bytes: Uint8Array): FlexBody` reads the envelope's fixed
// tags (`Status`, `ReferenceCode`, `ErrorCode`) with regular expressions over
// the raw bytes (design C3; wire-check.md W2). `flexErrorKind(errorCode: number)`
// maps an IBKR Flex error code to one of 'token' | 'query' | 'in-progress' |
// 'rate' | 'other' (design C3's W3 table, corrected by wire-check.md W3).
//
// | Criterion                                                      | Pre-condition                                   | Call (seam)                | Observable result                                           | Source |
// |-----------------------------------------------------------------|--------------------------------------------------|------------------------------|----------------------------------------------------------------|--------|
// | Envelope success                                                 | bytes of a FlexStatementResponse with Status=Success, a ReferenceCode and a Url | classifyFlexBody(bytes)   | `{ kind: 'envelope', status: 'Success', referenceCode: '5673718144' }`, no errorCode | design C3 FlexBody shape; wire-check.md W2 |
// | Envelope failure                                                 | bytes of a FlexStatementResponse with Status=Fail, an ErrorCode and an ErrorMessage | classifyFlexBody(bytes)   | `{ kind: 'envelope', status: 'Fail', errorCode: 1012 }`, no referenceCode | design C3 FlexBody shape; wire-check.md W2 |
// | XML prolog before an envelope still classifies as an envelope   | bytes of an `<?xml ...?>` prolog followed by the success envelope above | classifyFlexBody(bytes)   | `kind === 'envelope'` and the same status/referenceCode as the no-prolog case | task 8 _Prompt Success |
// | XML report                                                       | bytes of an XML Flex report (`FlexQueryResponse` root, no `Status` tag) | classifyFlexBody(bytes)   | `{ kind: 'xml-report' }`                                        | task 8 _Prompt Success; design C3 FlexBody shape |
// | CSV report                                                       | bytes of a CSV Flex report starting with the `ClientAccountID` header row | classifyFlexBody(bytes)   | `{ kind: 'report' }`                                            | task 8 _Prompt Success; wire-check.md W5, W6 |
// | flexErrorKind maps every checked W3 code to its kind            | one of the codes wire-check.md W3 confirms for each kind | flexErrorKind(code)       | 'token' for 1011/1012/1013/1015; 'query' for 1010/1014; 'in-progress' for 1001/1004-1009/1019/1021; 'rate' for 1018; 'other' for 1003/1016/1017/1020/1025 | design C3 W3 table; wire-check.md W3 |
// | flexErrorKind maps any other code to 'other'                    | a code absent from every W3 list (9999)          | flexErrorKind(9999)        | 'other'                                                         | design C3: "Any other code is other." |

import { describe, expect, it } from 'vitest';

import { classifyFlexBody, flexErrorKind } from './flex-wire';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const successEnvelope = enc(
  '<FlexStatementResponse timestamp="06 November, 2026, 10:00 AM EST">\n' +
    '<Status>Success</Status>\n' +
    '<ReferenceCode>5673718144</ReferenceCode>\n' +
    '<Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest</Url>\n' +
    '</FlexStatementResponse>',
);

const failureEnvelope = enc(
  '<FlexStatementResponse timestamp="06 November, 2026, 10:00 AM EST">\n' +
    '<Status>Fail</Status>\n' +
    '<ErrorCode>1012</ErrorCode>\n' +
    '<ErrorMessage>Token has expired.</ErrorMessage>\n' +
    '</FlexStatementResponse>',
);

const prologThenSuccessEnvelope = enc(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<FlexStatementResponse timestamp="06 November, 2026, 10:00 AM EST">\n' +
    '<Status>Success</Status>\n' +
    '<ReferenceCode>5673718144</ReferenceCode>\n' +
    '<Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest</Url>\n' +
    '</FlexStatementResponse>',
);

const xmlReport = enc(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<FlexQueryResponse queryName="Activity" type="AF">\n' +
    '<FlexStatements count="1">\n' +
    '<FlexStatement accountId="U1234567" fromDate="20260101" toDate="20260131">\n' +
    '<Trades>\n' +
    '</Trades>\n' +
    '</FlexStatement>\n' +
    '</FlexStatements>\n' +
    '</FlexQueryResponse>',
);

const csvReport = enc(
  'ClientAccountID,CurrencyPrimary,Symbol,TradeDate,Quantity,TradePrice\n' +
    'U1234567,USD,AAPL,20260102,100,150.25\n',
);

describe('classifyFlexBody', () => {
  it('classifies an envelope success body, with status and reference code', () => {
    expect(classifyFlexBody(successEnvelope)).toEqual({
      kind: 'envelope',
      status: 'Success',
      referenceCode: '5673718144',
    });
  });

  it('classifies an envelope failure body, with status and error code', () => {
    expect(classifyFlexBody(failureEnvelope)).toEqual({
      kind: 'envelope',
      status: 'Fail',
      errorCode: 1012,
    });
  });

  it('still classifies an envelope when an XML prolog precedes it', () => {
    const result = classifyFlexBody(prologThenSuccessEnvelope);
    expect(result).toEqual({
      kind: 'envelope',
      status: 'Success',
      referenceCode: '5673718144',
    });
  });

  it('classifies an XML report body as xml-report', () => {
    expect(classifyFlexBody(xmlReport)).toEqual({ kind: 'xml-report' });
  });

  it('classifies a CSV report body as report', () => {
    expect(classifyFlexBody(csvReport)).toEqual({ kind: 'report' });
  });
});

describe('flexErrorKind', () => {
  it.each([
    [1011, 'token'],
    [1012, 'token'],
    [1013, 'token'],
    [1015, 'token'],
    [1010, 'query'],
    [1014, 'query'],
    [1001, 'in-progress'],
    [1004, 'in-progress'],
    [1005, 'in-progress'],
    [1006, 'in-progress'],
    [1007, 'in-progress'],
    [1008, 'in-progress'],
    [1009, 'in-progress'],
    [1019, 'in-progress'],
    [1021, 'in-progress'],
    [1018, 'rate'],
    [1003, 'other'],
    [1016, 'other'],
    [1017, 'other'],
    [1020, 'other'],
    [1025, 'other'],
  ] as const)('maps code %i to %s', (code, kind) => {
    expect(flexErrorKind(code)).toBe(kind);
  });

  it('maps a code absent from every checked list to other', () => {
    expect(flexErrorKind(9999)).toBe('other');
  });
});
