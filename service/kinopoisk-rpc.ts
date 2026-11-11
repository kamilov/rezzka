import { isRecord, type ServiceResponse } from '../shared/settings';
import { KinopoiskError, type KinopoiskService } from './kinopoisk';

export type KinopoiskMethod = 'getKinopoiskStatus' | 'setKinopoiskKey' | 'getKinopoiskPerson';

export async function kinopoiskCall(service: KinopoiskService, method: KinopoiskMethod, params: unknown): Promise<ServiceResponse> {
  try {
    if (method === 'getKinopoiskStatus') {
      if (!isRecord(params) || Object.keys(params).length) return { returnValue: false, errorCode: 'invalid_request', errorText: 'Этот метод не принимает параметры.' };
      return { returnValue: true, kinopoiskStatus: await service.status() };
    }
    if (method === 'setKinopoiskKey') return { returnValue: true, kinopoiskStatus: await service.setKey(params) };
    return { returnValue: true, kinopoisk: await service.person(params) };
  } catch (error) {
    return error instanceof KinopoiskError
      ? { returnValue: false, errorCode: error.code, errorText: error.message }
      : { returnValue: false, errorCode: 'kinopoisk_unavailable', errorText: 'Не удалось получить дополнительные сведения Кинопоиска. Попробуйте ещё раз.' };
  }
}
