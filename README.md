# F1 Bridge

Este repositorio contiene el backend del puente F1 Bridge que conecta a los clientes WebSocket con los feeds de Formula 1 a través de la API de F1 TV.

## Qué hace el Bridge

- Conecta a `https://livetiming.formula1.com/signalrcore` usando SignalR.
- Recibe feeds en tiempo real como `CarData`, `Position`, `TimingData`, `WeatherData`, `RaceControlMessages`, etc.
- Mantiene un estado completo en memoria (`fullState.R`) para enviar a nuevos clientes WebSocket.
- Expone un servidor WebSocket en el puerto `5631` para que otros clientes puedan consumir los datos.
- Abre su propio túnel de ngrok apuntando a ese puerto (lanzando el binario `ngrok` como subproceso), así que no hace falta correr un contenedor ni un proceso de ngrok aparte: `docker compose up` (o `npm start`) deja el bridge y el túnel arriba juntos.
- Expone un servidor HTTP en el puerto `3000` que permite:
  - ver la documentación Swagger en `/swagger`
  - actualizar dinámicamente los tokens de F1 sin editar manualmente `.env`

## Endpoints principales

- `GET /` - Responde con un mensaje básico de estado.
- `GET /swagger` - Documentación Swagger de la API.
- `POST /api/config/update-token` - Actualiza `F1TVSUBSCRIPTION_TOKEN` en memoria (efecto inmediato, reconecta a F1 sin reiniciar el bridge) y además reescribe la línea correspondiente en `.env`, para que el próximo arranque del bridge ya use el token nuevo sin tener que llamar al endpoint otra vez.

### Ejemplo de petición para actualizar token

```http
POST http://<IP_CELULAR>:3000/api/config/update-token
Content-Type: application/json

{
  "F1TVSUBSCRIPTION_TOKEN": "nuevo_token",

}
```

## Configuración de red local

El servidor HTTP escucha en `0.0.0.0:3000`, lo que permite acceder desde otros dispositivos de la misma red Wi-Fi usando la IP local del celular.
Ejemplo: `http://192.168.x.x:3000/swagger`.

## Variables de entorno actuales (`.env`)

Todas son obligatorias: si falta alguna, el bridge lo reporta en consola y termina el proceso al iniciar (fail-fast), en vez de arrancar con un valor de relleno.

```dotenv
BRIDGE_PORT=
NGROK_AUTHTOKEN=
NGROK_DOMAIN=
F1TVSUBSCRIPTION_TOKEN=
```

- `NGROK_AUTHTOKEN`: token de tu cuenta de ngrok.
- `NGROK_DOMAIN`: dominio fijo de ngrok (sin esquema, ej. `tu-dominio.ngrok-free.dev`) al que se conectan los clientes por `wss://`.

Opcional (no requerida, tiene default):

- `NGROK_BIN_PATH`: ruta al ejecutable `ngrok` si no está en el `PATH`. Por defecto usa `ngrok`.

Corriendo con Docker, `docker-compose.yml` monta `./.env` como bind mount dentro del contenedor (`/app/.env`), así que cuando `/api/config/update-token` reescribe el archivo, el cambio queda en el `.env` del host y sobrevive a un `docker compose restart` o `docker compose up` posterior.

## Requisito: binario de ngrok

El bridge lanza `ngrok` como subproceso (no usa el SDK nativo de ngrok para npm, que en Termux/Android puede fallar por sus bindings nativos). Esto significa que `ngrok` tiene que estar instalado y accesible:

- **Docker**: ya viene instalado en la imagen (el `Dockerfile` lo instala vía el repo apt oficial de ngrok).
- **Termux**: instalar el binario oficial, por ejemplo:
  ```sh
  pkg install wget
  wget https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz
  tar -xvzf ngrok-v3-stable-linux-arm64.tgz
  mv ngrok $PREFIX/bin/
  ```
  Confirmá que quedó en el `PATH` con `ngrok version`.
- **Windows/Mac (desarrollo local)**: descargar el binario desde ngrok.com y dejarlo en el `PATH`, o apuntar `NGROK_BIN_PATH` a la ruta del ejecutable.
