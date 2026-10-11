import React from 'react';

const AppIcon: React.FC<{ size?: number; className?: string }> = ({ size = 22, className = '' }) => (
  <img
    src="./app-icon.jpg"
    width={size}
    height={size}
    alt="NIM4Ray"
    className={`rounded-lg object-cover shrink-0 ${className}`}
    style={{ width: size, height: size }}
  />
);

export default AppIcon;
