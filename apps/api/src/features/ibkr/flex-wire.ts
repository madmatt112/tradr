// The one file holding IBKR Flex Web Service wire knowledge (design C3).
// Pure, no I/O, no XML dependency: the envelope's fixed tags are read with
// regular expressions over the first bytes of the body.

export const FLEX_SEND_PATH = '/AccountManagement/FlexWebService/SendRequest';
export const FLEX_GET_PATH = '/AccountManagement/FlexWebService/GetStatement';
export const FLEX_API_VERSION = '3';
export const FLEX_ACCOUNT_COLUMN = 'ClientAccountID';

export type FlexBody =
  | { kind: 'envelope'; status: string; referenceCode?: string; errorCode?: number }
  | { kind: 'xml-report' }
  | { kind: 'report' };

const PREFIX_BYTES = 4096;
const PROLOG_RE = /^﻿?\s*<\?xml[^>]*\?>\s*/;
const ENVELOPE_TAG_RE = /^<FlexStatementResponse\b/;
const STATUS_RE = /<Status>([^<]*)<\/Status>/;
const REFERENCE_CODE_RE = /<ReferenceCode>([^<]*)<\/ReferenceCode>/;
const ERROR_CODE_RE = /<ErrorCode>(\d+)<\/ErrorCode>/;

export function classifyFlexBody(bytes: Uint8Array): FlexBody {
  const prefix = new TextDecoder('utf-8').decode(bytes.subarray(0, PREFIX_BYTES));
  const afterProlog = prefix.replace(PROLOG_RE, '');

  if (ENVELOPE_TAG_RE.test(afterProlog)) {
    const statusMatch = STATUS_RE.exec(prefix);
    const referenceMatch = REFERENCE_CODE_RE.exec(prefix);
    const errorMatch = ERROR_CODE_RE.exec(prefix);

    return {
      kind: 'envelope',
      status: statusMatch ? statusMatch[1] : '',
      ...(referenceMatch ? { referenceCode: referenceMatch[1] } : {}),
      ...(errorMatch ? { errorCode: Number(errorMatch[1]) } : {}),
    };
  }

  if (afterProlog.startsWith('<')) {
    return { kind: 'xml-report' };
  }

  return { kind: 'report' };
}

const TOKEN_ERROR_CODES = new Set([1011, 1012, 1013, 1015]);
const QUERY_ERROR_CODES = new Set([1010, 1014]);
const IN_PROGRESS_ERROR_CODES = new Set([1001, 1004, 1005, 1006, 1007, 1008, 1009, 1019, 1021]);
const RATE_ERROR_CODES = new Set([1018]);

export function flexErrorKind(
  errorCode: number,
): 'token' | 'query' | 'in-progress' | 'rate' | 'other' {
  if (TOKEN_ERROR_CODES.has(errorCode)) return 'token';
  if (QUERY_ERROR_CODES.has(errorCode)) return 'query';
  if (IN_PROGRESS_ERROR_CODES.has(errorCode)) return 'in-progress';
  if (RATE_ERROR_CODES.has(errorCode)) return 'rate';
  return 'other';
}
