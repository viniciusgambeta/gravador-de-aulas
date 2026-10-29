# Gravador de Aulas

App para Windows 10/11 (64 bits) que grava **tela + câmera + microfone**, edita e exporta videoaulas leves em MP4, e envia direto para o painel de aulas da **Comunidade MDE**.

## Instalar (equipe)

1. Rode `Gravador-de-Aulas-Setup-<versão>.exe`. O Windows pode mostrar "O Windows protegeu o computador": clique em **Mais informações → Executar assim mesmo** (o instalador não tem assinatura digital).
2. Ao abrir pela primeira vez, o app já vem com os layouts, a intro, o vídeo de transição e as configurações padrão da equipe.
3. Escolha sua tela, câmera e microfone.
4. Em **Configurações → Comunidade MDE**, cole a **sua** chave de API (Admin → Chaves de API no painel do MDE) e clique em **Salvar e testar**.

Se a câmera ou o microfone não aparecerem: Configurações do Windows → Privacidade → Câmera/Microfone → permitir que **aplicativos da área de trabalho** acessem.

## Recursos

- **Gravação**: layouts horizontais (16:9) e verticais (9:16), cada um com seus ajustes; troca de layout ao vivo (`Alt+Shift+1…9`); 1 arquivo ou 3 (final + câmera + tela); **selecionar só uma área da tela**; logo/marca d'água; áudio do computador; contagem regressiva; barra flutuante que não aparece no vídeo; o PC não dorme durante a gravação; avisos de pouco espaço em disco e de microfone sem som.
- **Roteiro**: janela flutuante com rolagem automática (teleprompter), invisível na gravação.
- **Sincronia da voz com a boca**: calibre cada câmera uma vez batendo palmas (Configurações → Gravação). O atraso medido é compensado já na gravação, então os arquivos saem sincronizados.
- **Editor**: cortes reais com prévia sem engasgos; remover pausas automaticamente; transições "alguns momentos depois"; intro automática; ajuste fino da sincronia; `J`/`K`/`L` (voltar / pausar / acelerar).
- **Vídeo final**: H.264 compacto (≈100–500 MB por hora), áudio nivelado em −16 LUFS sem estourar.
- **Galeria**: assistir, editar, renomear, excluir e ver o status de envio ao MDE.

## Atalhos

| Atalho | Ação |
| --- | --- |
| `Alt+Shift+R` | Iniciar / parar a gravação |
| `Alt+Shift+P` | Pausar / continuar |
| `Alt+Shift+1…9` | Trocar de layout |
| `Espaço`, `J`/`K`/`L` | Editor: tocar, voltar, pausar, acelerar |
| `Del`, `Q`, `W`, `T` | Editor: remover seleção, cortar início/fim, inserir transição |

## Desenvolvimento

```bash
npm install
npm start                         # roda o app
node scripts/export-defaults.js   # usa as configurações deste PC como padrão da equipe
npm run dist                      # gera o instalador em dist/
```

`build/defaults/` guarda os padrões que vão no instalador (layouts, preferências e as mídias de intro/transição/logo). As mídias não ficam no repositório: rode `node scripts/export-defaults.js` no PC com as configurações desejadas antes de gerar o instalador.

Requisitos para desenvolver: Node.js 20+ e Windows 10/11 (o app usa captura de tela e APIs do Windows).

## Licença

[MIT](LICENSE)
