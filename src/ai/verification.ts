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
    this.client = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;
  }

  async verify(record: SheetRecord, document: DocumentReaderResult): Promise<VerificationResult> {
    const comparisons: VerificationComparison[] = [
      { field: 'name', spreadsheet: record.fullName || record.firstManifestName, documentReader: document.name ?? '' },
      { field: 'nik', spreadsheet: record.nik, documentReader: document.nik ?? '' },
      { field: 'birthPlace', spreadsheet: record.birthPlace, documentReader: document.birthPlace ?? '' },
      { field: 'birthDate', spreadsheet: record.birthDate, documentReader: document.birthDate ?? '' },
      { field: 'address', spreadsheet: record.ktpAddress, documentReader: document.address ?? '' },
      { field: 'motherName', spreadsheet: record.motherName, documentReader: document.motherName ?? '' },
    ];

    if (!this.client) {
      return {
        decision: 'REVIEW',
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
            'You assist identity data verification. Be conservative. Return only JSON with decision MATCH, REVIEW, or MISMATCH; summary; and comparisons with field and notes. Do not approve ambiguous differences.',
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
            comparisons,
          }),
        },
      ],
    });

    const content = response.choices[0]?.message.content;
    if (!content) {
      return { decision: 'REVIEW', summary: 'AI returned no content.', comparisons };
    }

    const parsed = JSON.parse(content) as Partial<VerificationResult>;
    const decision = parsed.decision === 'MATCH' || parsed.decision === 'MISMATCH' ? parsed.decision : 'REVIEW';

    return {
      decision,
      summary: parsed.summary ?? 'AI verification completed.',
      comparisons: mergeComparisonNotes(comparisons, parsed.comparisons),
    };
  }
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
