# Windows Agent + Ceviz Orkestrasyon Planı

## Amaç

Windows base OS üzerinde çalışan bir agent (Codex/ACP) üzerinden Outlook/Microsoft Graph odaklı entegrasyon kurulumunu ve ilgili sistem hazırlıklarını yürütmek; Ceviz ise orchestrator/registrator olarak planlama, doğrulama, yönlendirme ve sonuç değerlendirme görevini üstlenir.

## Rol Dağılımı

### Ceviz (Orchestrator / Registrator)

- hedef mimariyi belirler
- görevleri fazlara böler
- Windows agent için uygulanabilir görev paketleri üretir
- üretilen çıktı, log ve dosyaları değerlendirir
- hata durumunda alternatif yol belirler
- gerekli repo/dokümantasyon/entegrasyon iskeletini düzenler

### Windows Agent (Executor)

- Windows tarafında komut çalıştırır
- PowerShell/.NET işlemlerini yürütür
- gerekli ise browser tabanlı kurulum adımlarını destekler
- local servis/proje iskeleti oluşturur
- auth ve Graph erişim testlerini çalıştırır
- çıktı ve dosya durumunu raporlar

### Local Bridge Service

- Windows üzerinde çalışır
- Outlook/Microsoft Graph erişimini yerelde toplar
- inbox/calendar gibi işlevler için teknik arayüz sunar
- daha sonra OpenClaw tarafına bağlanabilecek katman olur

## Fazlar

### Faz 1 — Hazırlık ve Yetenek Doğrulama

Hedef: Windows agent'ın gerçekten gerekli işleri yapabildiğini doğrulamak.

Kontrol listesi:

- PowerShell çalıştırabiliyor mu?
- dotnet SDK erişimi var mı?
- git erişimi var mı?
- tarayıcı açma veya kullanıcıyı portala yönlendirme kapasitesi var mı?
- local dosya oluşturma/düzenleme yapabiliyor mu?
- ağ erişimi ile NuGet/Graph uçlarına erişebiliyor mu?

### Faz 2 — Azure App Registration + Graph İzinleri

Hedef: Microsoft Graph erişimi için gerekli app registration yapısını kurmak.

Beklenen işler:

- tenant/account bağlamını netleştirme
- yeni App Registration oluşturma
- gerekli redirect URI belirleme
- Graph delegated permissions ekleme
- gerekirse admin consent gereksinimini not etme
- client/tenant metadata’yı güvenli şekilde saklama yaklaşımı belirleme

Olası ilk izin seti:

- Mail.Read
- Calendars.Read
- offline_access
- User.Read

### Faz 3 — Windows Local Bridge Servis İskeleti

Hedef: .NET tabanlı bir local bridge uygulaması oluşturmak.

İçerik:

- solution/proje oluşturma
- config yapısı
- secret yönetimi yaklaşımı
- auth callback veya device code akışı tercihi
- temel servis katmanları
- health endpoint
- inbox/calendar test endpointleri

### Faz 4 — Auth ve PoC

Hedef: gerçekten login olup veri çekebildiğimizi doğrulamak.

Başarı kriterleri:

- kullanıcı auth akışı başarılı
- access token alınabiliyor
- mailbox’tan örnek veri okunabiliyor
- calendar’dan örnek veri okunabiliyor
- hata/log yapısı oluşmuş

### Faz 5 — OpenClaw Entegrasyon Yolu

Hedef: bu local bridge’i benim kullanabileceğim operasyonel bir arayüze dönüştürmek.

Seçenekler:

- MCP server
- local wrapper tool
- Windows agent üzerinden görev delegasyonu
- HTTP bridge + kontrollü çağrı modeli

## Karar Notları

- Uzak Azure VM zorunlu değil.
- Azure/Entra tarafı kimlik ve izin kaydı için gerekebilir.
- Asıl servis Windows local makinede çalışabilir.
- Bu yaklaşım, base OS Windows olduğu için daha doğal ve sürdürülebilir.

## İlk Uygulanabilir Görev Paketi

Windows agent için ilk görev seti:

1. ortam doğrulama (pwsh, dotnet, git, network)
2. uygun bir çalışma klasörü seçimi
3. .NET sürüm bilgisini çıkarma
4. Graph bridge için önerilen proje yapısını yazma
5. gerekiyorsa boş solution ve web api iskeleti oluşturma
6. çıktı olarak durum raporu + oluşturulan dosya listesi verme

## Beklenen Kullanım Modeli

- Mert hedefi verir
- Ceviz görev paketini oluşturur
- Windows agent uygular
- Ceviz sonucu değerlendirir
- sonraki paket hazırlanır

## Açık Sorular

- Windows agent’ın erişebildiği çalışma dizini neresi?
- Browser automation var mı, yoksa kullanıcı manuel login mi yapacak?
- Secret saklama yöntemi ne olacak? (user secrets / env / Windows Credential Manager)
- Bridge servis sadece local mi kalacak, yoksa ileride kontrollü remote erişim mi eklenecek?
