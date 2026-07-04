# F1 Bridge

Este repositorio contiene el backend del puente F1 Bridge que conecta a los clientes WebSocket con los feeds de Formula 1 a través de la API de F1 TV.

## Qué hace el Bridge

- Conecta a `https://livetiming.formula1.com/signalrcore` usando SignalR.
- Recibe feeds en tiempo real como `CarData`, `Position`, `TimingData`, `WeatherData`, `RaceControlMessages`, etc.
- Mantiene un estado completo en memoria (`fullState.R`) para enviar a nuevos clientes WebSocket.
- Expone un servidor WebSocket en el puerto `5631` para que otros clientes puedan consumir los datos.
- Expone un servidor HTTP en el puerto `3000` que permite:
  - ver la documentación Swagger en `/swagger`
  - actualizar dinámicamente los tokens de F1 sin editar manualmente `.env`

## Endpoints principales

- `GET /` - Responde con un mensaje básico de estado.
- `GET /swagger` - Documentación Swagger de la API.
- `POST /api/config/update-token` - Actualiza las variables en memoria:
  - `F1TVSUBSCRIPTION_TOKEN`

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

```dotenv
BRIDGE_PORT=
NGROK_AUTHTOKEN=
F1TVSUBSCRIPTION_TOKEN=
```
