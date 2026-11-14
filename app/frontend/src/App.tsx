import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Studio from './pages/Studio';
import Share from './pages/Share';
import AuthCallback from './pages/AuthCallback';
import AuthError from './pages/AuthError';
// MODULE_IMPORTS_START
import { AuthProvider } from './contexts/AuthContext';
import LogoutCallbackPage from './pages/LogoutCallbackPage';
// MODULE_IMPORTS_END

const queryClient = new QueryClient();

const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<Studio />} />
    <Route path="/share/:token" element={<Share />} />
    <Route path="/auth/callback" element={<AuthCallback />} />
    <Route path="/auth/error" element={<AuthError />} />
    {/* MODULE_ROUTES_START */}
    <Route path='/logout-callback' element={<LogoutCallbackPage />} />
    {/* MODULE_ROUTES_END */}
    <Route path="*" element={<Studio />} />
  </Routes>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    {/* MODULE_PROVIDERS_START */}
    <AuthProvider>
    {/* MODULE_PROVIDERS_END */}
    <TooltipProvider>
      <Toaster position="bottom-center" />
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </TooltipProvider>
    </AuthProvider>
    {/* MODULE_PROVIDERS_CLOSE */}
  </QueryClientProvider>
);

export default App;
export { AppRoutes };
