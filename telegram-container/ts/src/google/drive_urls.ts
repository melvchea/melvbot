export function googleDocEditUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

export function googleSheetEditUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}
