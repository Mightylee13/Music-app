import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import LenzoApp from './MusicApp';

function App() {
  return (
    <TooltipProvider>
      <LenzoApp />
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
