import ts from 'typescript';

export const flattenDiagnosticMessage = (
  messageText: string | ts.DiagnosticMessageChain,
): string => ts.flattenDiagnosticMessageText(messageText, '\n');
