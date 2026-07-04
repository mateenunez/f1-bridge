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

> Atención: estos valores son sensibles. Quedan listados aquí solo para facilitar la prueba local y la migración, pero no es seguro mantenerlos en archivos públicos.

```dotenv
BRIDGE_PORT=5631
NGROK_AUTHTOKEN=3EoZUOqWMo3DAsZulp1CjxfM2j2_7Lhyhdx3MDLsi7kgrXnsj
F1TVSUBSCRIPTION_TOKEN=eyJraWQiOiIxIiwidHlwIjoiSldUIiwiYWxnIjoiUlMyNTYifQ.eyJFeHRlcm5hbEF1dGhvcml6YXRpb25zQ29udGV4dERhdGEiOiJBUkciLCJTdWJzY3JpcHRpb25TdGF0dXMiOiJhY3RpdmUiLCJTdWJzY3JpYmVySWQiOiIyMjU5NDAwODYiLCJGaXJzdE5hbWUiOiJNYXRlbyIsImVudHMiOlt7ImNvdW50cnkiOiJBUkciLCJlbnQiOiJSRUcifSx7ImNvdW50cnkiOiJBUkciLCJlbnQiOiJQUkVNSVVNIn1dLCJMYXN0TmFtZSI6Ik51w7FleiIsImV4cCI6MTc4MzQyMjE4NywiU2Vzc2lvbklkIjoiZXlKaGJHY2lPaUpvZEhSd09pOHZkM2QzTG5jekxtOXlaeTh5TURBeEx6QTBMM2h0YkdSemFXY3RiVzl5WlNOb2JXRmpMWE5vWVRJMU5pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SmlkU0k2SWpFd01ERXhJaXdpYzJraU9pSTJNR0U1WVdRNE5DMWxPVE5rTFRRNE1HWXRPREJrTmkxaFpqTTNORGswWmpKbE1qSWlMQ0pvZEhSd09pOHZjMk5vWlcxaGN5NTRiV3h6YjJGd0xtOXlaeTkzY3k4eU1EQTFMekExTDJsa1pXNTBhWFI1TDJOc1lXbHRjeTl1WVcxbGFXUmxiblJwWm1sbGNpSTZJakl5TlRrME1EQTROaUlzSW1sa0lqb2lNREZsTUdGak5XWXRZelUyWVMwME1EZ3dMVGcxWldNdFlURmlOamd6TmpKaE5qQXdJaXdpZENJNklqRWlMQ0pzSWpvaVpYTXRUVmdpTENKa1l5STZJak0yTkRRaUxDSmhaV1FpT2lJeU1ESTJMVEEzTFRFM1ZERXhPakF6T2pBMkxqZ3lNMW9pTENKa2RDSTZJakVpTENKbFpDSTZJakl3TWpZdE1EZ3RNREpVTVRFNk1ETTZNRFl1T0RJeldpSXNJbU5sWkNJNklqSXdNall0TURjdE1EUlVNVEU2TURNNk1EWXVPREl6V2lJc0ltbHdJam9pTWpBeExqSXhPUzR4TmpZdU9EZ2lMQ0pqSWpvaVZrbE1URUVnVFVWU1EwVkVSVk1pTENKd1l5STZJa1ExTnpNd0lpd2lZMjhpT2lKQlVrY2lMQ0p1WW1ZaU9qRTNPRE13TnpZMU9EWXNJbVY0Y0NJNk1UYzROVFkyT0RVNE5pd2lhWE56SWpvaVlYTmpaVzVrYjI0dWRIWWlMQ0poZFdRaU9pSmhjMk5sYm1SdmJpNTBkaUo5LlliVG9NNWFFYllHQ1ppRUhHV3ZxTFRWbW9JVFJjanRudmY4VnNCS1l4cUUiLCJpYXQiOjE3ODMwNzY1ODcsIlN1YnNjcmliZWRQcm9kdWN0IjoiRjEgVFYgUHJlbWl1bSBNb250aGx5IiwianRpIjoiNmE4ZTEzZjItMjFmNi00MDY0LWI2NzUtMjAwM2E4ZGI2NDNmIiwiaGFzaGVkU3Vic2NyaWJlcklkIjoiMHZ2bzQ2U0J5SkVxWmx2VHlNRUtyN2FKQ05rSGJYOExTXC9FQW45YXF6RXc9In0.TxC6fkWjdlz_5B1pJDa-ATy2m8sXj6ocRipwDZd-9gGmMhocDMYOytxahiRoYnSR6CY90q6SyhXYitPN9CHE_zcePPLbhKQfwV5gm-cCxZ5WXLeaPFcyLeTzC8E3oDhMIrX-jmVh6zF6AWdJj5WaLonzcmcJ_ytArrqL54xX18Yx37a39WGLlBviBb0MdQ78BxoFrLbIY-owUFo0wiI3v2DssG3MzW5UT37xNBRSDCAwrentHZyXgWNAlTTq2Wn1K08c64chaER0Py9Ww2NRC00feHR4Sj5Q
```

## Qué probar

1. Inicia la app con `pnpm exec ts-node src/app.ts` o el comando habitual de tu proyecto.
2. En tu laptop, abre `http://<IP_CELULAR>:3000/swagger`.
3. Envía la petición `POST /api/config/update-token` con un JSON válido.
4. Si todo funciona, puedes borrar el archivo `.env` y seguir usando el endpoint para actualizar tokens en memoria.

## Nota

Después de borrar `.env`, la aplicación seguirá manteniendo los valores en memoria hasta que se reinicie. Si reinicias la app, necesitarás volver a proporcionar el token usando `/api/config/update-token` o restaurar un `.env` válido.
