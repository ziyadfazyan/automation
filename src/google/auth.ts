import dns from 'node:dns';
import { google } from 'googleapis';

dns.setDefaultResultOrder('ipv4first');

export function createGoogleAuth() {
  return new google.auth.GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}
