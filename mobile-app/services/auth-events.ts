/**
 * Eşleştirme ekranına "neden buradasın" bilgisini taşıyan minik bellek içi kanal.
 *
 * PLATFORMA ÖZEL DEĞİL (alias'lanmıyor) - hem mobil hem masaüstü aynı dosyayı
 * kullanıyor; yalnızca yazan taraf (services/api.ts'teki 401 işleyicisi)
 * platforma göre değişiyor.
 *
 * Neden var: 401 alındığında handleUnauthorized() kimlik bilgilerini siliyor ve
 * /pair-device'a yönlendiriyordu, ama ekran HİÇBİR açıklama göstermiyordu.
 * Kullanıcı kodu yapıştırıp kaydediyor, ekran kapanıyor, 10 saniye sonra burst
 * kontrol 401 alıp aynı ekranı yeniden açıyordu - üstelik az önce kaydedilen
 * kimlik silinmiş oluyordu. Kullanıcı aynı kodu tekrar yapıştırıp aynı döngüye
 * giriyordu. Artık ekran ne olduğunu söyleyebiliyor.
 *
 * Kalıcı DEĞİL (AsyncStorage değil): bilgi yalnızca yönlendirmeyi yapan oturum
 * için anlamlı, uygulama yeniden açıldığında taşınmamalı.
 */
export type PairingReason = 'unauthorized';

let pendingReason: PairingReason | null = null;

/** 401 işleyicisi tarafından, yönlendirmeden hemen önce çağrılır. */
export function setPairingReason(reason: PairingReason): void {
  pendingReason = reason;
}

/** Eşleştirme ekranı açılırken bir kez okur ve tüketir. */
export function consumePairingReason(): PairingReason | null {
  const reason = pendingReason;
  pendingReason = null;
  return reason;
}
