# Resource Bar (extensão GNOME Shell)

Monitor de recursos para o painel superior do GNOME, inspirado no widget **sysmon** da barra do
[Noctalia Shell](https://github.com/noctalia-dev/noctalia-shell). Cada métrica vira um item compacto:
**ícone + medidor (ou gráfico) + valor**, e a cor muda para a cor de destaque conforme o valor passa
dos limites de *atividade* e *crítico*, como no Noctalia.

Compatível com GNOME Shell 48–51 (testado no 51.1, Wayland).

## O que mostra

| ID | Métrica | Fonte |
|---|---|---|
| `cpu_usage` | Uso da CPU (opcional: uma barra por núcleo) | `/proc/stat` |
| `cpu_temp` | Temperatura da CPU | hwmon `k10temp`/`zenpower` (Tctl/Tdie), `coretemp`, zonas térmicas |
| `cpu_freq` | Frequência média | `/proc/cpuinfo` |
| `gpu_usage`, `gpu_temp`, `gpu_vram`, `gpu_vram_used` | GPU | NVIDIA via `nvidia-smi`, AMD via sysfs |
| `ram_pct`, `ram_used` | Memória | `/proc/meminfo` (`MemTotal − MemAvailable`) |
| `swap_pct` | Swap | `/proc/meminfo` |
| `disk_used_pct`, `disk_used`, `disk_free_pct`, `disk_free` | Disco: o padrão ou um disco específico (`disk_used_pct:/mnt/dados`) | `/proc/self/mounts` + `statfs` via GIO |
| `net_rx`, `net_tx` | Download / upload | `/proc/net/dev` (por padrão, só interfaces físicas) |

Ao clicar no painel abre um menu com cartões de CPU (com barras por núcleo), memória/swap, rede
(download e upload no mesmo gráfico) e GPU, uma lista com todos os discos montados (barra, % e usado/total)
e a carga média com o tempo ligado.

### Vários discos

Os discos são detectados em `/proc/self/mounts`: entram sistemas de arquivos locais (ext4, btrfs, xfs,
ntfs3, exfat, vfat…) e ficam de fora `/boot`, `/efi`, imagens somente leitura (ISO) e pseudo-sistemas.
Subvolumes btrfs do mesmo disco (`/` e `/home`) aparecem uma vez só.

Nas preferências, ao adicionar uma métrica de disco você escolhe qual disco ela mostra, e **Todos os discos**
adiciona um “Disco usado (%)” para cada disco que ainda não está no painel. Cada item de disco mostra o nome
do disco (ex.: `KIOXIA-SSD`) ao lado do ícone; se o disco for desmontado, o item mostra `--`.

## Instalação

```bash
git clone https://github.com/Ticko4/gnome-resource-bar.git
cd gnome-resource-bar
./install.sh
```

O script copia a extensão para `~/.local/share/gnome-shell/extensions` e a marca como ativa.
No Wayland, encerre a sessão e entre de novo para ela aparecer no painel.

Para gerar um `.zip` instalável: `./install.sh --pack`.

## Configuração

`gnome-extensions prefs resource-bar@local` (ou **Configurações** no menu da extensão):

- **Painel**: quais métricas e em que ordem; visualização (medidor, gráfico ou nenhuma); ícone, valor,
  unidades, medidor por núcleo, largura mínima do valor, espaçamento, animação suave, cores dos gráficos
  (padrão, cor de destaque do sistema ou uma cor por recurso como no Resources: CPU azul, memória roxo,
  GPU vermelho, discos laranja, rede azul-esverdeado; só os gráficos mudam, não as barras), cor de alerta (padrão `#FD4663`, o “error” do Noctalia);
  área e posição no painel.
- **Monitoramento**: intervalo (padrão 1 s), disco padrão, interface de rede,
  unidade e formato compacto da velocidade.
- **Limites**: atividade/crítico por grupo, com os padrões do Noctalia (CPU 50/90 %, temperatura 60/85 °C,
  RAM 60/90 %, swap 20/80 %, disco 80/95 %, rede 1/50 MB/s…).

## Como funciona

- Toda leitura é assíncrona (`Gio.File.load_contents_async`, `query_filesystem_info_async`); o shell
  nunca bloqueia esperando o kernel.
- Só lê o que é necessário: GPU e frequência só são lidas quando estão no painel ou com o menu aberto.
- NVIDIA: um único processo `nvidia-smi --loop-ms` fica rodando enquanto a GPU é necessária
  (bem mais barato que iniciar o programa a cada segundo) e é encerrado quando não é mais.
- GPUs em suspensão automática (`runtime_status = suspended`) não são acordadas só para leitura.
- Animação suave (ligada por padrão): a cada leitura os medidores deslizam até o valor novo e os gráficos
  rolam continuamente (a leitura entra pela direita; mudanças de escala, como um novo pico de rede, também
  são suavizadas). A animação dura um pouco mais que o intervalo e cada leitura continua o movimento a
  partir do que está na tela, então nada para entre leituras. A largura dos valores no painel só encolhe
  depois de 10 s, para os itens não se deslocarem. Limitada a ~30 fps; mudanças de menos de 1/4 de pixel
  não animam, e a opção “Reduzir animação” do GNOME desliga tudo. No modo gráfico o painel é redesenhado
  continuamente, o que custa um pouco mais; dá para desligar em Aparência.
- Cor: abaixo do limite de atividade o item usa a cor do texto do painel; ao passar dele, já começa
  com 25 % de destaque e vai a 100 % no crítico (mesma curva do Noctalia).

## Estrutura

```
resource-bar@local/
├── extension.js      indicador, timer, configurações
├── prefs.js          janela de preferências (libadwaita)
├── stylesheet.css
├── lib/sampler.js    leitura de /proc, /sys, nvidia-smi
├── lib/stats.js      catálogo de métricas, formatação, limites, histórico
├── lib/widgets.js    medidor, barras por núcleo, gráfico, item do painel
├── lib/popup.js      cartões do menu
├── lib/color.js      utilitários de cor
├── icons/            ícones simbólicos
└── schemas/          GSettings
```

## Limitações

- GPU Intel integrada: sem uso/VRAM (o kernel não expõe isso de forma simples).
- O `nvidia-smi` mantém a GPU NVIDIA acordada enquanto roda; em notebooks com GPU híbrida, deixe as
  métricas de GPU fora do painel se quiser que ela suspenda.

## Licença

GPL-2.0-or-later. Veja [LICENSE](LICENSE).

O visual e os limites padrão seguem o widget sysmon do [Noctalia Shell](https://github.com/noctalia-dev/noctalia-shell)
(MIT); nenhum código do Noctalia foi copiado.
