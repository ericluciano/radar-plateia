# Componentes de terceiros embarcados em `web/vendor/`

Tudo aqui roda dentro do navegador; nada é baixado de CDN em tempo de execução (o app funciona offline e com Wi-Fi ruim).

| Pasta | O que é | Versão | Licença |
| --- | --- | --- | --- |
| `tasks-vision/` | MediaPipe Tasks Vision (Google) — motor WASM de detecção | 1.0.1 | Apache-2.0 |
| `models/blaze_face_short_range.tflite` | Detector de rostos (MediaPipe) | — | Apache-2.0 |
| `models/efficientdet_lite0.tflite` | Detector de objetos/pessoas EfficientDet-Lite0 float16 (MediaPipe) | — | Apache-2.0 |
| `face-api/` | @vladmandic/face-api (TensorFlow.js + FaceNet) — reconhecimento facial opt-in | 1.7.15 | MIT (ver `face-api/LICENSE`) |
| `face-api/model/` | Pesos: `face_recognition_model`, `face_landmark_68_tiny_model` | — | MIT (distribuídos com o face-api) |

O reconhecimento facial só é carregado quando o usuário liga o recurso e confirma o consentimento; os outros modos não tocam nesses arquivos.
