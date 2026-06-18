import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

export function VisualPreloader({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // --- COMMENT THIS OUT FOR TESTING ---
    // const hasSeenIntro = sessionStorage.getItem("vocera_visual_intro_2");
    // if (hasSeenIntro) {
    //   setIsLoading(false);
    //   return;
    // }
    // ------------------------------------
    const timer = setTimeout(() => {
      setIsLoading(false);
      sessionStorage.setItem("vocera_visual_intro_2", "true");
    }, 2500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <AnimatePresence>
        {isLoading && (
          <motion.div
            key="preloader"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.8, ease: "easeInOut" } }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-background"
          >
            <div className="relative flex items-center justify-center gap-2">
              <motion.div
                animate={{ height: ["16px", "48px", "16px"] }}
                transition={{ duration: 1, repeat: Infinity, ease: "easeInOut", delay: 0 }}
                className="w-3 rounded-full bg-primary/80 shadow-glow"
              />
              <motion.div
                animate={{ height: ["24px", "64px", "24px"] }}
                transition={{ duration: 1, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
                className="w-3 rounded-full bg-primary shadow-glow"
              />
              <motion.div
                animate={{ height: ["16px", "48px", "16px"] }}
                transition={{ duration: 1, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
                className="w-3 rounded-full bg-primary/80 shadow-glow"
              />
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 2.5, opacity: [0, 0.5, 0] }}
                transition={{ duration: 2, ease: "easeOut", times: [0, 0.5, 1], repeat: Infinity }}
                className="absolute h-16 w-16 rounded-full border border-primary/30"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: isLoading ? 0 : 1, scale: isLoading ? 0.98 : 1 }}
        transition={{ duration: 0.8, delay: 0.2 }}
        className="min-h-screen"
      >
        {!isLoading && children}
      </motion.div>
    </>
  );
}
