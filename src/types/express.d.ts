/**
 * Extensión global de la interfaz Request de Express para incluir
 * los datos de autenticación inyectados por el authMiddleware.
 */
declare namespace Express {
  interface Request {
    /** ID del usuario autenticado extraído del JWT */
    userId?: string;
    /**
     * Lista de nombres de cubos OLAP a los que el usuario tiene acceso.
     * `null` indica que BYPASS_AUTH está activo y se permite acceso a todos los cubos.
     */
    allowedCubes?: string[] | null;
    /** Token JWT del request (mismo usado contra el Launcher). */
    launcherToken?: string;
    /** Perfil desde GET {API_LAUNCHER}/users/{userId}; puede faltar si el Launcher falla. */
    launcherUser?: {
      id: string;
      email: string;
      firstName?: string;
      lastName?: string;
      username?: string;
      role: string;
      customerId?: string | null;
      products?: string[];
    };
  }
}
