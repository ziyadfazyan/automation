import OpenAI from 'openai';
import { config } from '../config.js';
import {
  DocumentReaderResult,
  SheetRecord,
  VerificationComparison,
  VerificationResult,
} from '../types/record.js';

export class VerificationAi {
  private readonly client: OpenAI | null;

  constructor() {
    this.client = config.OPENAI_API_KEY
      ? new OpenAI({
        apiKey: config.OPENAI_API_KEY,
        baseURL: config.OPENAI_BASE_URL,
      })
      : null;
  }

  async verify(record: SheetRecord, document: DocumentReaderResult): Promise<VerificationResult> {
    const comparisons: VerificationComparison[] = [
      { field: 'name', spreadsheet: record.fullName || record.firstManifestName, documentReader: document.name ?? '' },
      { field: 'nik', spreadsheet: record.nik, documentReader: document.nik ?? '' },
      { field: 'birthPlace', spreadsheet: record.birthPlace, documentReader: document.birthPlace ?? '' },
      { field: 'birthDate', spreadsheet: record.birthDate, documentReader: document.birthDate ?? '' },
      { field: 'address', spreadsheet: record.ktpAddress, documentReader: comparisonAddress(document) },
      { field: 'motherName', spreadsheet: record.motherName, documentReader: document.motherName ?? '' },
    ];

    if (!this.client) {
      return {
        decision: deterministicDecision(comparisons, 'REVIEW'),
        summary: 'OPENAI_API_KEY is not configured. Manual review is required.',
        comparisons,
      };
    }

    const response = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You assist identity data verification. Be conservative. KTP Vision/final KTP data is the primary document source. System/Rails DB and Scan/Document Reader are context only. Return only JSON with decision MATCH, REVIEW, or MISMATCH; summary; and comparisons with field and notes. Do not approve ambiguous differences.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            policy: {
              acceptable: [
                'case differences',
                'extra whitespace',
                'minor punctuation differences',
                'obvious date formatting differences when day/month/year are identical',
              ],
              notAcceptable: [
                'different names',
                'different NIK values',
                'different dates of birth',
                'materially different address or birth place',
                'missing required values',
              ],
            },
            sources: {
              spreadsheet: {
                name: record.fullName || record.firstManifestName,
                nik: record.nik,
                birthPlace: record.birthPlace,
                birthDate: record.birthDate,
                address: record.ktpAddress,
                motherName: record.motherName,
              },
              systemRailsDb: document.systemFields ?? {},
              scanDocumentReader: document.scannedFields ?? document.rawFields ?? {},
              ktpVisionPrimary: document.ktpVision ?? {},
              finalDocumentUsedForComparison: {
                name: document.name ?? '',
                nik: document.nik ?? '',
                birthPlace: document.birthPlace ?? '',
                birthDate: document.birthDate ?? '',
                address: comparisonAddress(document),
                motherName: document.motherName ?? '',
              },
            },
            comparisons,
          }),
        },
      ],
    });

    const content = response.choices[0]?.message.content;
    if (!content) {
      return { decision: 'REVIEW', summary: 'AI returned no content.', comparisons };
    }

    const parsed = JSON.parse(stripJsonFence(content)) as Partial<VerificationResult>;
    const decision = parsed.decision === 'MATCH' || parsed.decision === 'MISMATCH' ? parsed.decision : 'REVIEW';

    const guardedDecision = deterministicDecision(comparisons, decision);
    return {
      decision: guardedDecision,
      summary: parsed.summary ?? 'AI verification completed.',
      comparisons: mergeComparisonNotes(comparisons, parsed.comparisons),
    };
  }
}

function deterministicDecision(comparisons: VerificationComparison[], aiDecision: VerificationResult['decision']): VerificationResult['decision'] {
  if (comparisons.some((comparison) => !comparison.spreadsheet.trim() || !comparison.documentReader.trim())) return 'REVIEW';

  const exactFields: VerificationComparison['field'][] = ['nik', 'birthDate'];
  if (comparisons.some((comparison) => exactFields.includes(comparison.field) && normalizeLoose(comparison.spreadsheet) !== normalizeLoose(comparison.documentReader))) {
    return 'MISMATCH';
  }

  const reviewFields: VerificationComparison['field'][] = ['name', 'birthPlace', 'address', 'motherName'];
  if (aiDecision === 'MATCH' && comparisons.some((comparison) => reviewFields.includes(comparison.field) && isLooseMismatch(comparison))) {
    return 'REVIEW';
  }

  return aiDecision;
}

function comparisonAddress(document: DocumentReaderResult): string {
  const address = document.address ?? '';
  const rtRw = document.ktpVision?.rtRw ?? '';
  if (!address.trim() || !rtRw.trim()) return address;
  return `${address} RT/RW ${rtRw}`;
}

function isLooseMismatch(comparison: VerificationComparison): boolean {
  if (comparison.field === 'address') {
    return !addressesEquivalent(comparison.spreadsheet, comparison.documentReader);
  }
  return normalizeLoose(comparison.spreadsheet) !== normalizeLoose(comparison.documentReader);
}

function normalizeLoose(value: string): string {
  return value.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function addressesEquivalent(left: string, right: string): boolean {
  const leftParts = splitAddress(left);
  const rightParts = splitAddress(right);
  if (leftParts.base !== rightParts.base) return false;
  if (!leftParts.rtRw || !rightParts.rtRw) return leftParts.rtRw === rightParts.rtRw;
  return leftParts.rtRw === rightParts.rtRw;
}

function splitAddress(value: string): { base: string; rtRw: string } {
  const upper = value.toUpperCase();
  const rtRwMatch =
    upper.match(/\bRT\s*\/?\s*RW\s*0*(\d+)\s*\/\s*0*(\d+)/i) ??
    upper.match(/\bRT\s*0*(\d+)\s*RW\s*0*(\d+)/i) ??
    upper.match(/\bRT\s*0*(\d+)\s*\/\s*0*(\d+)/i);
  const base = upper
    .replace(/\bRT\s*\/?\s*RW\s*\d+\s*\/\s*\d+.*/i, '')
    .replace(/\bRT\s*\d+\s*RW\s*\d+.*/i, '')
    .replace(/\bRT\s*\d+\s*\/\s*\d+.*/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const rtRw = rtRwMatch ? `${Number(rtRwMatch[1])}/${Number(rtRwMatch[2])}` : '';
  return { base, rtRw };
}

function stripJsonFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function mergeComparisonNotes(
  original: VerificationComparison[],
  aiComparisons: unknown,
): VerificationComparison[] {
  if (!Array.isArray(aiComparisons)) return original;
  return original.map((comparison) => {
    const aiComparison = aiComparisons.find(
      (item) => typeof item === 'object' && item && 'field' in item && item.field === comparison.field,
    ) as { notes?: string } | undefined;
    return { ...comparison, notes: aiComparison?.notes };
  });
}
