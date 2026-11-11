import type { TitleFact } from './source';

export interface KinopoiskStatus { configured: boolean; revision: number }
export interface KinopoiskPersonQuery {
  filmId?: string; personId?: string; name: string; originalName?: string; profession?: string; birthDate?: string;
}
export interface KinopoiskPerson {
  id: string; name: string; originalName?: string; photo?: string; profileUrl: string; facts: TitleFact[]; trivia: string[];
}
export type KinopoiskResult = { status: 'disabled' | 'unmatched' | 'ambiguous' } | { status: 'matched'; person: KinopoiskPerson };
