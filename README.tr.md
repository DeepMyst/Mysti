<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a> | <a href="README.pt-BR.md">Português</a> | <a href="README.ar.md">العربية</a> | <a href="README.de.md">Deutsch</a> | <a href="README.fr.md">Français</a> | Türkçe | <a href="README.ru.md">Русский</a>
</p>

# Mysti - Birlikte Çalışan Yapay Zeka Kodlama Ekibiniz

<p align="center">
  <img src="resources/Mysti-Logo.png" alt="Mysti Logosu" width="128" height="128">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/v/DeepMyst.mysti?style=flat-square&label=Version" alt="Sürüm">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/i/DeepMyst.mysti?style=flat-square&label=Installs" alt="Kurulumlar">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/visual-studio-marketplace/r/DeepMyst.mysti?style=flat-square&label=Rating" alt="Puan">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=flat-square&label=Stars" alt="GitHub Stars">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/network/members">
    <img src="https://img.shields.io/github/forks/DeepMyst/Mysti?style=flat-square&label=Forks" alt="GitHub Forks">
  </a>
  <a href="https://github.com/DeepMyst/Mysti/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square" alt="Lisans">
  </a>
</p>

<p align="center">
  <strong>VSCode için Yapay Zeka Kodlama Ekibiniz</strong><br>
  <em>11 Yapay Zeka sağlayıcısı — Claude Code, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen Code, Ollama ve LocalAI — tek başına veya ekip olarak çalışır</em><br>
  <em>Birden fazla ajanın kolektif zekasının tek bir ajanı aştığı kalabalıkların bilgeliği.</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">
    <img src="https://img.shields.io/badge/VS%20Code%20Marketplace'den%20Kur-007ACC?style=for-the-badge&logo=visual-studio-code" alt="VS Code Marketplace'den Kur">
  </a>
</p>

<p align="center">
  <a href="#yapay-zekanızı-seçin">Sağlayıcılar</a> •
  <a href="#beyin-fırtınası-modu">Beyin Fırtınası</a> •
  <a href="#temel-özellikler">Özellikler</a> •
  <a href="#hızlı-başlangıç">Hızlı Başlangıç</a> •
  <a href="#yapılandırma">Yapılandırma</a> •
  <a href="#dokümantasyon">Dokümanlar</a>
</p>

---

## v0.3.4'teki Yenilikler

### 11 Yapay Zeka Sağlayıcısı

Mysti artık **11 yapay zeka sağlayıcısını** destekliyor — Claude Code, Codex, Gemini, GitHub Copilot, Cline, Cursor ve OpenClaw'ın yanına **OpenCode**, **Qwen Code**, **Ollama** ve **LocalAI** eklendi. Ollama/LocalAI ile yerel modeller çalıştırın veya OpenCode ve Qwen Code gibi bulut sağlayıcıları kullanın. Her sağlayıcının arayüzde kendine özgü logosu var.

### Qwen Code

Alibaba'nın derin akıl yürütme yeteneklerine sahip yapay zeka kodlama CLI'ı. Sorunsuz entegrasyon için Claude Code ile aynı akış protokolünü kullanır. Plan, auto-edit ve yolo onay modlarıyla Qwen3 Coder modellerini destekler.

### OpenCode

Tek bir CLI üzerinden Anthropic, OpenAI, Google ve Groq'u destekleyen çoklu arka uç kodlama ajanı. Yapılandırılmış varsayılan modelinizi kullanır — belirli sağlayıcılara bağımlılık yok.

### Yerel Yapay Zeka Desteği

**Ollama** ve **LocalAI** ile yapay zeka modellerini yerel olarak çalıştırın — bulut aboneliği gerekmez. Tam gizlilik, sıfır gecikme, modelleriniz üzerinde tam kontrol.

---

## Saniyeler İçinde Kurulum

**VS Code'dan:** `Ctrl+P` (Mac'te `Cmd+P`) tuşlarına basın, ardından yapıştırın:

```
ext install DeepMyst.mysti
```

**Veya** [VS Code Marketplace'den kurun](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

---

## Yapay Zekanızı Seçin

Mysti, zaten sahip olduğunuz yapay zeka kodlama araçlarıyla çalışır. **Ekstra abonelik gerekmez.**

<p align="center">
  <img src="docs/gifs/agent switching.gif" alt="Ajan Değiştirme" width="450">
</p>

| Sağlayıcı | En İyi Kullanım |
|-----------|----------------|
| **Claude Code** | Derin akıl yürütme, karmaşık yeniden yapılandırma, kapsamlı analiz |
| **Codex** | Hızlı iterasyonlar, tanıdık OpenAI stili |
| **Gemini** | Hızlı yanıtlar, Google ekosistemi entegrasyonu |
| **GitHub Copilot** | GitHub aboneliği ile çoklu model erişimi (Claude, GPT-5, Gemini) |
| **Cline** | Plan/Act modu, yapılandırılmış görev tamamlama |
| **Cursor** | Otomatik model seçimi, Claude, GPT-5, Gemini ile çoklu model |
| **OpenClaw** | Gerçek zamanlı WebSocket akışı, yapılandırılabilir düşünme seviyeleri |
| **OpenCode** | Çoklu arka uç ajanı (Anthropic, OpenAI, Google, Groq) |
| **Qwen Code** | Alibaba'nın yapay zeka kodlama ajanı, derin akıl yürütme |
| **Ollama** | Yerel LLM çıkarımı, gizlilik öncelikli, abonelik gereksiz |
| **LocalAI** | Kendi barındırdığınız yapay zeka modelleri, tam kontrol |

**Tek tıkla sağlayıcı değiştirin. Bağımlılık yok.**

### Neden Mysti?

| Copilot/Cursor'a Karşı | Mysti Avantajı |
|------------------------|---------------|
| Tek yapay zeka | **Çoklu ajan beyin fırtınası** — iki yapay zeka 5 stratejiyle işbirliği yapar |
| Tek sağlayıcıya bağımlı | **11 sağlayıcı** — Claude, Codex, Gemini, Copilot, Cline, Cursor, OpenClaw, OpenCode, Qwen, Ollama, LocalAI |
| Kara kutu | **Tam izin kontrolü** — salt okunurdan tam erişime |
| Genel yanıtlar | **16 persona** — mimar, hata ayıklayıcı, güvenlik uzmanı... |
| Manuel iş akışı | **Otonom mod** — yapay zeka güvenlik kontrolleriyle bağımsız çalışır |
| Ajanlar arası yönlendirme yok | **@bahsetme** — görevleri satır içinde belirli ajanlara yönlendirin |

---

## Çalışırken Görün

<p align="center">
  <img src="docs/gifs/main screen.gif" alt="Mysti Sohbet Arayüzü" width="700">
</p>

<p align="center"><em>Sözdizimi vurgulama, Markdown desteği ve Mermaid diyagramlarıyla güzel, modern sohbet arayüzü</em></p>

<p align="center">
  <img src="docs/gifs/Task list rendering and progress tracking.gif" alt="Görev Listesi Oluşturma" width="700">
</p>

<p align="center"><em>Gerçek zamanlı görev listesi oluşturma ve ilerleme takibi</em></p>

---

## Beyin Fırtınası Modu

**İkinci bir görüş mü istiyorsunuz?** Beyin Fırtınası Modunu etkinleştirin ve iki yapay zeka ajanının sorununuzu birlikte çözmesine izin verin. Ayarlar panelinden **11 ajandan herhangi 2'sini seçin**.

<p align="center">
  <img src="docs/gifs/brainstorm example.gif" alt="Beyin Fırtınası Modu" width="700">
</p>

### 5 İşbirliği Stratejisi

| Strateji | Roller | En İyi Kullanım |
|----------|--------|----------------|
| **Quick** | Doğrudan sentez | Basit görevler, hızlı yanıtlar |
| **Debate** | Eleştirmen vs Savunucu | Mimari kararlar, ödünleşimler |
| **Red-Team** | Teklif Eden vs Meydan Okuyan | Güvenlik incelemeleri, uç durum keşfi |
| **Perspectives** | Risk Analisti vs Yenilikçi | Sıfırdan tasarım, teknoloji seçimi |
| **Delphi** | Kolaylaştırıcı vs İyileştirici | Karmaşık sorunlar, uzlaşmaya varma |

### Neden İki Yapay Zeka Birden İyidir

**Claude Code** (Anthropic), **Codex** (OpenAI), **Gemini** (Google), **GitHub Copilot**, **Cline**, **Cursor**, **OpenClaw**, **OpenCode**, **Qwen Code** (Alibaba), **Ollama** ve **LocalAI** farklı eğitimlere, farklı güçlü yönlere ve farklı kör noktalara sahiptir. Herhangi ikisi birlikte çalıştığında:

- Her yapay zeka diğerinin kaçırabileceği uç durumları yakalar
- Farklı bakış açıları daha sağlam çözümlere yol açar
- **Birlikte** tartışır, birbirlerine meydan okur ve en iyi çözümü sentezler

Kıdemli bir geliştirici ve teknik liderin kodunuzu incelemesi gibi — farkı, gerçekten önce tartışmaları.

### Yakınsama Tespiti

Tartışmalar sırasında Mysti, ajan anlaşmasını ve pozisyon kararlılığını takip eder. **Otomatik yakınsama** etkinleştirildiğinde, ajanlar uzlaşmaya vardığında tartışma erken sona erer — kaliteden ödün vermeden zaman kazandırır.

### Ekibinizi Seçin

**Ayarlar Panelinde** hangi iki ajanın işbirliği yapacağını yapılandırın:

<p align="center">
  <img src="docs/gifs/Brainstorm model selection.gif" alt="Beyin Fırtınası Model Seçimi" width="600">
</p>

| Kombinasyon | En İyi Kullanım |
|------------|----------------|
| Claude + Codex | Derin analiz hızlı iterasyonla buluşur |
| Claude + Gemini | Kapsamlı akıl yürütme hızlı doğrulamayla |
| Claude + Copilot | Yerel Claude vs Copilot'un çoklu model yaklaşımını karşılaştırın |
| Cursor + Gemini | Çoklu model esnekliği Google entegrasyonuyla |
| OpenClaw + Claude | WebSocket akışı derin akıl yürütmeyle |
| Qwen + Claude | Alibaba ve Anthropic akıl yürütmesini karşılaştırın |
| OpenCode + Gemini | Çoklu arka uç esnekliği Google hızıyla |
| Ollama + Claude | Yerel gizlilik bulut zekasıyla buluşur |

[Tam Beyin Fırtınası dokümantasyonu](docs/BRAINSTORM.md)

### Akıllı Plan Tespiti

Yapay zeka birden fazla uygulama yaklaşımı sunduğunda, Mysti bunları otomatik olarak tespit eder ve tercih ettiğiniz yolu seçmenize olanak tanır.

<p align="center">
  <img src="docs/screenshots/plan-suggestions.png" alt="Plan Önerileri" width="600">
</p>

*En az 2 CLI aracının kurulu olması gerekir. Bkz. [Gereksinimler](#gereksinimler).*

---

## Temel Özellikler

### Otonom Mod

Yapay zekanın yapılandırılabilir güvenlik kontrolleriyle bağımsız çalışmasına izin verin:

- **Güvenlik Sınıflandırıcı**: Üç seviye — güvenli (otomatik onay), dikkat (moda bağlı), engelli (her zaman reddet)
- **Üç Güvenlik Modu**: Muhafazakâr, Dengeli, Agresif
- **Öğrenme Belleği**: İzin tercihlerinizi hatırlar ve zamanla gelişir
- **Devam Modları**: Uzatılmış otonom oturumlar için hedef tabanlı veya görev kuyruğu
- **Denetim İzi**: Her otonom karar inceleme için kaydedilir

<p align="center">
  <img src="docs/gifs/Selecting autonomy mode.gif" alt="Otonomi Modunu Seçme" width="600">
</p>

[Tam Otonom Mod dokümantasyonu](docs/AUTONOMOUS-MODE.md)

### @Bahsetme Sistemi

Görevleri belirli ajanlara yönlendirin ve dosyaları satır içinde referans gösterin:

<p align="center">
  <img src="docs/gifs/Agent tagging and multi agent workflows.gif" alt="@Bahsetme Etiketleme" width="600">
</p>

```
@claude Bu kodu güvenlik sorunları için incele
@src/auth.ts @gemini Bu dosya için performans iyileştirmeleri öner
@claude Testler yaz, sonra @codex optimize et
```

- **Dosya bahsetmeleri**: `@filename` geçici bağlam ekler
- **Ajan bahsetmeleri**: `@agent` görevleri o sağlayıcıya yönlendirir
- **Zincirleme**: Sonraki ajanlar önceki ajanların yanıtlarını bağlam olarak alır

[Tam @Bahsetme dokümantasyonu](docs/MENTIONS.md)

### Bağlam Sıkıştırma

Bağlam taşmasını önleyen akıllı sohbet yönetimi:

- **Otomatik**: Token kullanımı eşiğe yaklaştığında tetiklenir (varsayılan %75)
- **Yerel destek**: Claude Code yerleşik `/compact` komutunu kullanır
- **İstemci tarafı**: Diğer sağlayıcılar akıllı mesaj özetleme kullanır
- **Panel bazlı takip**: Her sohbet paneli kullanımı bağımsız olarak takip eder

[Tam Sıkıştırma dokümantasyonu](docs/COMPACTION.md)

### 16 Geliştirici Persona

Yapay zekanızın nasıl düşündüğünü şekillendirin. Yapay zekanın sorunlarınıza yaklaşımını değiştiren uzmanlaşmış personalar arasından seçin.

<p align="center">
  <img src="docs/gifs/Personas and skills.gif" alt="Persona ve Beceriler Paneli" width="550">
</p>

| Persona | Odak |
|---------|------|
| **Mimar** | Sistem tasarımı, ölçeklenebilirlik, temiz yapı |
| **Hata Ayıklayıcı** | Kök neden analizi, hata düzeltme |
| **Güvenlik Odaklı** | Güvenlik açıkları, tehdit modelleme |
| **Performans Ayarlayıcı** | Optimizasyon, profilleme, gecikme |
| **Prototipçi** | Hızlı iterasyon, PoC'ler |
| **Yeniden Yapılandırıcı** | Kod kalitesi, bakım kolaylığı |
| + 10 daha... | Full-Stack, DevOps, Mentor, Tasarımcı... |

[Tam Persona & Beceriler dokümantasyonu](docs/PERSONAS-AND-SKILLS.md)

---

### Hızlı Persona Seçimi

Panel açmadan doğrudan araç çubuğundan persona seçin.

<p align="center">
  <img src="docs/screenshots/persona-toolbar.png" alt="Araç Çubuğu Persona Seçimi" width="550">
</p>

---

### Akıllı Otomatik Öneriler

Mysti mesajınıza göre otomatik olarak ilgili persona ve eylemler önerir.

<p align="center">
  <img src="docs/gifs/PErsona Suggestion.gif" alt="Otomatik Öneriler" width="550">
</p>

---

### Sohbet Geçmişi

Çalışmanızı asla kaybetmeyin. Tüm sohbetler kaydedilir ve kolayca erişilebilir.

<p align="center">
  <img src="docs/screenshots/conversation-history.png" alt="Sohbet Geçmişi" width="450">
</p>

---

### Karşılama Hızlı Eylemleri

Yaygın görevler için tek tıklama eylemleriyle hızlıca başlayın.

<p align="center">
  <img src="docs/screenshots/quick-actions-welcome.png" alt="Hızlı Eylemler" width="550">
</p>

---

### Kapsamlı Ayarlar

Token bütçeleri, erişim seviyeleri ve beyin fırtınası modu dahil Mysti'nin her yönünü ince ayarlayın.

<p align="center">
  <img src="docs/screenshots/settings-panel.png" alt="Ayarlar Paneli" width="450">
</p>

---

## Gereksinimler

**Zaten Claude, ChatGPT, Gemini veya GitHub Copilot için ödeme yapıyor musunuz? Hazırsınız.**

Mysti mevcut aboneliklerinizle çalışır — ek maliyet yok!

| CLI Aracı | Abonelik | Kurulum |
|-----------|----------|--------|
| **Claude Code** (önerilen) | Anthropic API veya Claude Pro/Max | `npm install -g @anthropic-ai/claude-code` |
| **GitHub Copilot CLI** | GitHub Copilot Pro/Pro+/Business | `npm install -g @github/copilot-cli` |
| **Gemini CLI** | Google AI API veya Gemini Advanced | `npm install -g @google/gemini-cli` |
| **Codex CLI** | OpenAI API | OpenAI kurulum kılavuzunu takip edin |
| **Cline** | Model sağlayıcısına bağlı | `npm install -g cline` |
| **Cursor** | Cursor aboneliği | `curl https://cursor.com/install -fsS \| bash` |
| **OpenClaw** | OpenClaw hesabı | `npm install -g openclaw@latest && openclaw onboard --install-daemon` |
| **OpenCode** | Sağlayıcı API anahtarları (Anthropic, OpenAI, vb.) | `npm i -g opencode-ai@latest` |
| **Qwen Code** | Qwen OAuth veya API anahtarları | `npm install -g @qwen-code/qwen-code@latest` |
| **Ollama** | Yerel (abonelik gerekmez) | [ollama.com'dan kurun](https://ollama.com) |
| **LocalAI** | Yerel (abonelik gerekmez) | [localai.io'dan kurun](https://localai.io) |

Başlamak için sadece **bir** CLI'ye ihtiyacınız var. Beyin Fırtınası Modunu açmak için **herhangi ikisini** kurun.

---

## Hızlı Başlangıç

### 1. Mysti'yi Kurun

**Seçenek A:** `Ctrl+P` (Mac'te `Cmd+P`) tuşlarına basın, yapıştırın ve çalıştırın:
```
ext install DeepMyst.mysti
```

**Seçenek B:** [VS Code Marketplace'den kurun](https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti)

### 2. CLI Aracı Kurun

```bash
# Claude Code (önerilen)
npm install -g @anthropic-ai/claude-code
claude auth login

# Veya GitHub Copilot CLI (GitHub üzerinden Claude, GPT-5, Gemini'ye erişin)
npm install -g @github/copilot-cli
copilot  # sonra /login komutunu kullanın

# Veya Gemini CLI
npm install -g @google/gemini-cli
gemini auth login

# Veya Cursor
curl https://cursor.com/install -fsS | bash
agent login

# Veya OpenClaw
npm install -g openclaw@latest && openclaw onboard --install-daemon
openclaw login

# Veya OpenCode
npm i -g opencode-ai@latest
opencode auth login

# Veya Qwen Code
npm install -g @qwen-code/qwen-code@latest
qwen  # sonra /auth yazın
```

Beyin Fırtınası Modu için herhangi iki CLI aracı kurun.

### 3. Mysti'yi Açın

- Etkinlik Çubuğundaki **Mysti simgesine** tıklayın veya
- `Ctrl+Shift+M` (Mac'te `Cmd+Shift+M`) tuşlarına basın

### 4. Kodlamaya Başlayın

İsteğinizi yazın ve yapay zekanın size yardım etmesine izin verin!

---

## Eğik Çizgi Komutları

Yerleşik eğik çizgi komut menüsüyle becerilere ve eylemlere hızlıca erişin.

<p align="center">
  <img src="docs/gifs/slash commands menu.gif" alt="Eğik Çizgi Komutları Menüsü" width="600">
</p>

---

## 12 Açılıp Kapanabilen Beceri

Davranış değiştiricileri karıştırın ve eşleştirin:

- **Özlü** - Net, kısa iletişim
- **Test Odaklı** - Kodla birlikte testler
- **Otomatik Commit** - Artımlı commitler
- **İlk İlkeler** - Temel akıl yürütme
- **Kapsam Disiplini** - Göreve odaklı kalma
- Ve 7 tane daha...

[Tam Persona & Beceriler dokümantasyonu](docs/PERSONAS-AND-SKILLS.md)

---

## İzin Kontrolleri

Yapay zekanın yapabileceklerini kontrol altında tutun:

- **Salt okunur** - Yapay zeka yalnızca okuyabilir, asla değiştiremez
- **İzin iste** - Her dosya değişikliğini onaylayın
- **Tam erişim** - Yapay zekanın otonom çalışmasına izin verin

<p align="center">
  <img src="docs/gifs/Semi auto answering questions .gif" alt="İzin Kontrolleri Demosu" width="600">
</p>

---

## Yapılandırma

### Temel Ayarlar

```json
{
  "mysti.defaultProvider": "claude-code",
  "mysti.brainstorm.agents": ["claude-code", "google-gemini"],
  "mysti.brainstorm.strategy": "quick",
  "mysti.accessLevel": "ask-permission"
}
```

### Sağlayıcı Ayarları

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `mysti.defaultProvider` | `claude-code` | Birincil yapay zeka sağlayıcısı |
| `mysti.claudePath` | `claude` | Claude CLI yolu |
| `mysti.codexPath` | `codex` | Codex CLI yolu |
| `mysti.geminiPath` | `gemini` | Gemini CLI yolu |
| `mysti.copilotPath` | `copilot` | Copilot CLI yolu |
| `mysti.clinePath` | `cline` | Cline CLI yolu |
| `mysti.cursorPath` | `agent` | Cursor CLI yolu |
| `mysti.openclawPath` | `openclaw` | OpenClaw CLI yolu |
| `mysti.opencodePath` | `opencode` | OpenCode CLI yolu |
| `mysti.qwenCodePath` | `qwen` | Qwen Code CLI yolu |
| `mysti.ollamaPath` | `ollama` | Ollama CLI yolu |
| `mysti.localaiPath` | `localai` | LocalAI CLI yolu |

### Beyin Fırtınası Ayarları

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `mysti.brainstorm.agents` | `["claude-code", "openai-codex"]` | Hangi 2 ajan kullanılacak |
| `mysti.brainstorm.strategy` | `quick` | Strateji: `quick`, `debate`, `red-team`, `perspectives`, `delphi` |
| `mysti.brainstorm.autoConverge` | `true` | Ajanlar yakınsadığında otomatik çıkış |
| `mysti.brainstorm.maxDiscussionRounds` | `3` | Maksimum tartışma turu |

### Otonom Ayarlar

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `mysti.autonomous.safetyMode` | `balanced` | `conservative`, `balanced`, `aggressive` |
| `mysti.autonomous.blockPatterns` | `[]` | Her zaman engellenecek özel kalıplar |

### Sıkıştırma Ayarları

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `mysti.compaction.enabled` | `true` | Bağlam sıkıştırmayı etkinleştir |
| `mysti.compaction.threshold` | `75` | Sıkıştırma eşiği (bağlam penceresinin %'si) |

### Genel Ayarlar

| Ayar | Varsayılan | Açıklama |
|------|-----------|----------|
| `mysti.accessLevel` | `ask-permission` | Dosya erişim seviyesi |
| `mysti.agents.autoSuggest` | `true` | Personaları otomatik öner |
| `mysti.agents.maxTokenBudget` | `0` | Ajan bağlamı için maks token (0 = sınırsız) |

[Tam Sağlayıcılar dokümantasyonu](docs/PROVIDERS.md)

---

## Klavye Kısayolları

| Eylem | Windows/Linux | Mac |
|-------|---------------|-----|
| Mysti'yi Aç | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| Yeni Sekmede Aç | `Ctrl+Shift+N` | `Cmd+Shift+N` |

---

## Komutlar

| Komut | Açıklama |
|-------|----------|
| `Mysti: Open Chat` | Sohbet kenar çubuğunu aç |
| `Mysti: New Conversation` | Yeni sohbet başlat |
| `Mysti: Add to Context` | Dosya/seçimi bağlama ekle |
| `Mysti: Clear Context` | Tüm bağlamı temizle |
| `Mysti: Open in New Tab` | Sohbeti düzenleyici sekmesi olarak aç |

---

## Dokümantasyon

| Kılavuz | Açıklama |
|---------|----------|
| [Sağlayıcılar](docs/PROVIDERS.md) | Tüm 11 sağlayıcı — kurulum, modeller, özellikler |
| [Beyin Fırtınası Modu](docs/BRAINSTORM.md) | 5 strateji, yakınsama, ekip seçimi |
| [Persona & Beceriler](docs/PERSONAS-AND-SKILLS.md) | 16 persona, 12 beceri, özel ajanlar |
| [Otonom Mod](docs/AUTONOMOUS-MODE.md) | Güvenlik sistemi, bellek, devam modları |
| [@Bahsetme](docs/MENTIONS.md) | Ajan yönlendirme ve dosya bağlamı |
| [Sıkıştırma](docs/COMPACTION.md) | Bağlam yönetimi ve özetleme |
| [Mimari](docs/ARCHITECTURE.md) | Teknik iç yapı ve uzantı noktaları |
| [Özellikler](docs/FEATURES.md) | Tam özellik referansı |

---

## Telemetri

Mysti uzantıyı geliştirmek için **anonim** kullanım verileri toplar:

- Özellik kullanım kalıpları
- Hata oranları
- Sağlayıcı tercihleri

**Hiçbir kod, dosya yolu veya kişisel veri asla toplanmaz.**

VSCode'un telemetri ayarına uyar. Devre dışı bırakma:
Ayarlar > Telemetry: Telemetry Level > off

---

## Katkıda Bulunanlar

Mysti'yi daha iyi yapmaya yardımcı olan herkese teşekkürler!

<a href="https://github.com/BahaAbuNojaim"><img src="https://avatars.githubusercontent.com/u/6247079?v=4" width="60" height="60" style="border-radius:50%" alt="BahaAbuNojaim" /></a>
<a href="https://github.com/MostlyKIGuess"><img src="https://avatars.githubusercontent.com/u/135974627?v=4" width="60" height="60" style="border-radius:50%" alt="MostlyKIGuess" /></a>
<a href="https://github.com/a-programmers-programmer"><img src="https://avatars.githubusercontent.com/u/161260774?v=4" width="60" height="60" style="border-radius:50%" alt="a-programmers-programmer" /></a>
<a href="https://github.com/patrick-fu"><img src="https://avatars.githubusercontent.com/u/20736775?v=4" width="60" height="60" style="border-radius:50%" alt="patrick-fu" /></a>

Katılmak ister misiniz? Aşağıdaki [Katkıda Bulunma](#katkıda-bulunma) bölümüne göz atın.

---

## Star Geçmişi

Mysti işinize yaradıysa, bir star vermeyi düşünün — başkalarının projeyi keşfetmesine yardımcı olur ve bizi motive eder!

<p align="center">
  <a href="https://github.com/DeepMyst/Mysti/stargazers">
    <img src="https://img.shields.io/github/stars/DeepMyst/Mysti?style=for-the-badge&logo=github&color=yellow" alt="GitHub Stars" />
  </a>
</p>

<p align="center">
  <a href="https://star-history.com/#DeepMyst/Mysti&Date">
    <img src="https://api.star-history.com/svg?repos=DeepMyst/Mysti&type=Date" width="600" alt="Star Geçmişi Grafiği" />
  </a>
</p>

---

## Katkıda Bulunma

Katkıları memnuniyetle karşılıyoruz! Hata raporları, özellik istekleri veya kod katkıları olabilir.

- **İyi İlk Issue'lar**: [`good first issue`](https://github.com/DeepMyst/Mysti/labels/good%20first%20issue) etiketlerini arayın
- **Geliştirme**: VS Code'da `F5` tuşuna basarak Uzantı Geliştirme Host'unu başlatın
- **Pull Request**: Fork yapın, özellik dalı oluşturun ve PR gönderin

Ayrıntılı yönergeler için [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın.

---

## Lisans

Apache License 2.0 — ticari amaçlar dahil kullanmak, değiştirmek ve dağıtmak serbesttir.
Tam metin için `LICENSE` dosyasına bakın.

---

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti">Kur</a> •
  <a href="https://github.com/DeepMyst/Mysti/issues">Sorun Bildir</a> •
  <a href="https://github.com/DeepMyst/Mysti">GitHub</a>
</p>

<p align="center">
  <strong>Mysti</strong> — <a href="https://www.deepmyst.com/mysti">DeepMyst Inc</a> tarafından oluşturuldu<br>
  <sub>Mysti ile yapıldı</sub>
</p>
