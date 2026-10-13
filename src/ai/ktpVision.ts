import fs from 'node:fs/promises';
import OpenAI from 'openai';
import { config } from '../config.js';
import { KtpVisionResult } from '../types/record.js';

export class KtpVisionAi {
  private readonly client: OpenAI | null;

  constructor() {
    this.client = config.OPENAI_API_KEY
      ? new OpenAI({
        apiKey: config.OPENAI_API_KEY,
        baseURL: config.OPENAI_BASE_URL,
      })
      : null;
  }

  async readKtp(imagePath: string): Promise<KtpVisionResult | null> {
    if (!this.client) return null;

    const image = await fs.readFile(imagePath);
    const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const response = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Read Indonesian KTP identity data from the image. Return only JSON. Be conservative; if a field is unclear, leave it empty and lower confidence.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract from KTP: name, nik, birthPlace, birthDate in DD-MM-YYYY if visible, address WITHOUT RT/RW, rtRw, kelurahan, kecamatan, kabupatenKota from the KABUPATEN/KOTA line above Kecamatan, gender/jenis kelamin, job/pekerjaan, marriageStatus/status perkawinan, education/pendidikan, confidence HIGH/MEDIUM/LOW, notes.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${image.toString('base64')}`,
              },
            },
          ],
        },
      ],
    });

    const content = response.choices[0]?.message.content;
    if (!content) return null;

    const parsed = JSON.parse(stripJsonFence(content)) as Partial<KtpVisionResult>;
    return {
      name: clean(parsed.name),
      nik: clean(parsed.nik),
      birthPlace: clean(parsed.birthPlace),
      birthDate: clean(parsed.birthDate),
      address: clean(parsed.address),
      rtRw: clean(parsed.rtRw),
      kelurahan: clean(parsed.kelurahan),
      kecamatan: clean(parsed.kecamatan),
      kabupatenKota: clean(parsed.kabupatenKota),
      gender: clean(parsed.gender),
      job: clean(parsed.job),
      marriageStatus: clean(parsed.marriageStatus),
      education: clean(parsed.education),
      confidence: parsed.confidence === 'HIGH' || parsed.confidence === 'MEDIUM' || parsed.confidence === 'LOW' ? parsed.confidence : 'LOW',
      notes: clean(parsed.notes),
    };
  }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function stripJsonFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}
