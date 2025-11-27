import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive }) => {
  const bars = 5;
  
  return (
    <div className="flex items-center justify-center gap-1.5 h-12">
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          className={`w-2 rounded-full bg-orange-600 transition-all duration-300 ${
            isActive ? 'animate-pulse' : 'h-2 opacity-50'
          }`}
          style={{
            height: isActive ? `${Math.max(20, Math.random() * 100)}%` : '8px',
            animationDelay: `${i * 0.1}s`
          }}
        />
      ))}
    </div>
  );
};

export default Visualizer;