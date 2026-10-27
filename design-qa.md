# Control visual de los filtros de timings

## Alcance

Integrar el formulario al tema existente sin modificar las rutas, los nombres de
los campos, la lógica de filtrado ni los scripts de interacción. La validación
descrita en este informe se realizó localmente, sin acceso a producción.

## Evidencia y comparación

Capturas guardadas fuera del repositorio, en las visualizaciones de esta conversación:

- Referencia: `timing-filters-main-20261027.png`.
- Implementación: `timing-theme-final-20261027.png`.
- Pantalla angosta: `timing-theme-mobile-20261027.png`.
- Comparación de escritorio: mismo viewport CSS de 1280 × 720, fechas iguales,
  endpoint CLIENTES, errores, mínimo 2000 ms y una fila con JSON expandido.
- Referencia e implementación: 1280 × 719 píxeles, sin normalización de densidad
  ni reescalado. Las capturas intermedias con cabecera incompleta
  fueron descartadas; la captura final conserva la ventana visible completa.
- Se compararon referencia e implementación en una misma entrada visual, sin
  reescalar ni editar imágenes. El foco de la revisión fue el bloque de filtros;
  el desplazamiento vertical de tabla y JSON es consecuencia prevista del panel.

## Hallazgos y resultado

- Corregidos los campos nativos grises, las alturas dispares y las etiquetas en línea.
- Campos de 36 px, radio de 6 px y colores de la paleta existente; endpoint más ancho.
- Panel alineado a la izquierda, acción principal diferenciada y restablecimiento secundario.
- Sin desbordamiento interno en 1280, 800 y 390 px: cinco columnas, dos y una,
  respectivamente. En pantalla angosta los controles miden 40 px de alto.
- Foco de teclado visible y mensaje de error legible con anuncio `aria-live` conservado.
- Aplicar, paginar, actualizar y restablecer funcionaron; tabla y JSON coincidieron.
- Consola sin errores. Los scripts de interacción son idénticos al commit base.
- Prueba nueva observada en RED y luego GREEN; suite: 149 aprobadas, una omitida
  por permisos Windows, cero fallos. TypeScript sin emisión correcto.

No quedan hallazgos P0/P1/P2 dentro del bloque modificado. La cabecera y el ancho
de la tabla en móvil son preexistentes y están fuera del alcance. No se afirma
conformidad completa de accesibilidad ni verificación de todos los navegadores.

final result: passed
