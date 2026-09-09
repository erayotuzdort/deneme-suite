import os from 'node:os';

/**
 * Bu bilgisayarın, telefonun bağlanabileceği adreslerini bulur.
 *
 * Neden gerekli: eşleştirme kodu yalnızca deviceId + token taşıyor, ADRESİ
 * taşımıyor. Kullanıcı telefona ayrıca bir sunucu adresi girmek zorunda ve
 * bu adresi (Tailscale IP'si) bulmak için Tailscale arayüzüne bakması
 * gerekiyordu. Artık eşleştirme kartında doğrudan yazıyor.
 *
 * Tailscale, cihazlarına 100.64.0.0/10 (RFC 6598 "carrier-grade NAT")
 * aralığından adres veriyor - ör. 100.64.0.1. Bu aralık ev/ofis ağlarında
 * kullanılmadığından, arayüz adına hiç bakmadan bile güvenilir bir işaret;
 * arayüz adını yalnızca ek bir doğrulama olarak kullanıyoruz (Tailscale
 * arayüzünü farklı adlandıran kurulumlar var). Dış bir bağımlılık ya da
 * `tailscale` CLI çağrısı gerekmiyor.
 */

export type NetworkAddress = {
  /** Telefona yazılacak tam adres, ör. "http://100.64.0.1:4000". */
  url: string;
  ip: string;
  /** tailscale: her yerden erişilir. lan: yalnızca aynı ağda. */
  kind: 'tailscale' | 'lan';
  /** Adresin bulunduğu ağ arayüzünün adı. */
  interfaceName: string;
};

export type NetworkInfo = {
  hostName: string;
  /** Önerilen adres önce gelir (Tailscale varsa o). Hiçbiri yoksa boş. */
  addresses: NetworkAddress[];
};

/** 100.64.0.0/10 — Tailscale'in cihaz adresleri bu aralıktan geliyor. */
function isCgnat(ip: string): boolean {
  const o = ip.split('.').map(Number);
  return o.length === 4 && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

/** RFC 1918 özel ağ aralıkları - aynı Wi-Fi'daki telefon için işe yarar. */
function isPrivateLan(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4) return false;
  if (o[0] === 10) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  return false;
}

/**
 * Hyper-V/WSL/Docker'ın sanal anahtarları da RFC 1918 adresi taşıyor ama
 * telefondan erişilemez; listede gerçek adreslerin önüne geçmesinler.
 */
function isVirtualAdapter(name: string): boolean {
  return /vethernet|virtualbox|vmware|hyper-v|docker|wsl|loopback/i.test(name);
}

export function getNetworkInfo(port: number): NetworkInfo {
  const addresses: NetworkAddress[] = [];

  for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Node 18+ family'yi bazı platformlarda sayı (4) olarak veriyor.
      const isIpv4 = entry.family === 'IPv4' || (entry.family as unknown as number) === 4;
      if (!isIpv4 || entry.internal) continue;

      const tailscale = isCgnat(entry.address) || /tailscale/i.test(interfaceName);
      if (!tailscale && (!isPrivateLan(entry.address) || isVirtualAdapter(interfaceName))) continue;

      addresses.push({
        ip: entry.address,
        url: `http://${entry.address}:${port}`,
        kind: tailscale ? 'tailscale' : 'lan',
        interfaceName,
      });
    }
  }

  // Tailscale adresleri başa: telefon farklı bir ağdayken de çalışan tek
  // seçenek onlar, kullanıcıya önce doğru olanı göstermeliyiz.
  addresses.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tailscale' ? -1 : 1));

  return { hostName: os.hostname(), addresses };
}
