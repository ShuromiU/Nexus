import React from 'react';

interface GreetingProps {
  name: string;
  count?: number;
}

/** A greeting component */
const Greeting: React.FC<GreetingProps> = ({ name, count = 0 }) => {
  return <div>Hello {name}, count: {count}</div>;
};

export default Greeting;
