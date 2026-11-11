export type ContentKind = 'film' | 'series' | 'cartoon' | 'anime' | 'unknown';
export type CatalogSort = 'last' | 'popular' | 'watching' | 'new';
export type CatalogType = '0' | '1' | '2' | '3' | '82';
export type BrowseType = 'films' | 'series' | 'cartoons' | 'animation';
export interface BrowseFilters { type: BrowseType; genre: string; year: string }
export interface FilterOption { value: string; label: string }
export interface TitleRating { source: 'Кинопоиск' | 'IMDb' | 'HDrezka' | 'World Art'; value: string; votes?: string }
export interface TitleFact { label: string; value: string }
export interface TitlePerson { id?: string; name: string; photo?: string; job?: string; url?: string }
export interface PersonFilmography { role: string; items: TitleSummary[] }
export interface PersonDetails {
  id: string; url: string; name: string; originalName?: string; photo?: string; birthDate?: string;
  facts: TitleFact[]; filmography: PersonFilmography[];
}
/** `number` and `season` are the numeric parts of the source labels; absent when a label has no number. */
export interface ScheduleEpisode { episode: string; number?: string; title?: string; date: string; relative?: string; watched?: boolean }
export interface ScheduleSeason { title: string; season?: string; episodes: ScheduleEpisode[] }
/** A released episode from the source's series updates block. `tracked` marks series the account follows. */
export interface SeriesUpdate { url: string; id: string; title: string; season: string; episode: string; voice?: string; date?: string; tracked: boolean }
/** One frame of the seek preview: a region of a sprite image valid for a time range in seconds. */
export interface SeekFrame { start: number; end: number; image: string; x: number; y: number; width: number; height: number }
export interface FranchisePart { title: string; url?: string; id?: string; year?: string; rating?: string }
export type CommentText = { kind: 'text'; text: string } | { kind: 'break' } |
  { kind: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; children: CommentText[] };
export interface TitleComment { id: string; author: string; date: string; content: CommentText[]; avatar?: string; indent: number; parentId?: string; likes?: number }
export interface CommentsPage { items: TitleComment[]; nextPage?: number; total?: number }

export interface TitleSummary {
  id: string;
  url: string;
  title: string;
  poster: string;
  kind: ContentKind;
  year?: string;
  meta?: string;
  rating?: string;
  ratings?: TitleRating[];
}
export interface Voice {
  id: string;
  label: string;
  premium?: boolean;
  isAds?: string;
  isCamrip?: string;
  isDirector?: string;
}
export interface Episode { id: string; season: string; title: string }
export interface TitleDetails extends TitleSummary {
  isSeries?: boolean;
  originalTitle?: string;
  kinopoiskFilmId?: string;
  description: string;
  duration?: string;
  voices: Voice[];
  episodes: Episode[];
  selectedVoiceId?: string;
  selectedEpisode?: Episode;
  related: TitleSummary[];
  facts?: TitleFact[];
  people?: TitlePerson[];
  schedule?: ScheduleSeason[];
  franchise?: FranchisePart[];
  commentCount?: number;
}
export interface CatalogPage { items: TitleSummary[]; nextPage?: number; updates?: SeriesUpdate[] }
export interface BrowsePage extends CatalogPage { genres: FilterOption[]; years: FilterOption[] }
export interface FavoriteCollection { id: string; name: string; count?: number }
export interface FavoriteMembership { id: string; name: string; selected: boolean }
export interface FavoritesPage extends CatalogPage { collections: FavoriteCollection[]; selectedCollectionId?: string }
export interface Stream { quality: string; url: string }
export interface Subtitle { label: string; url: string }
export interface Playback { streams: Stream[]; subtitles: Subtitle[]; thumbnails?: string }

export type SourceRequest =
  | { operation: 'catalog'; page: number; sort: CatalogSort; type: CatalogType }
  | ({ operation: 'browse'; page: number } & BrowseFilters)
  | { operation: 'continue' }
  | { operation: 'continueSave'; url: string; id: string; voice: Voice; season?: string; episode?: string }
  | { operation: 'thumbnails'; url: string }
  | { operation: 'favorites'; collectionId?: string; page: number }
  | { operation: 'favoriteToggle'; url: string; id: string; collectionId: string }
  | { operation: 'favoriteCreate'; url: string; id: string; name: string }
  | { operation: 'ratings'; url: string; id: string }
  | { operation: 'comments'; url: string; id: string; page: number }
  | { operation: 'search'; query: string; page: number }
  | { operation: 'details'; url: string }
  | { operation: 'person'; url: string }
  | { operation: 'episodes'; id: string; voice: Voice }
  | { operation: 'streams'; id: string; voice: Voice; season?: string; episode?: string };
export interface SourceDocument { body: string; url: string }
