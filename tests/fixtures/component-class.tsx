import React from 'react';

interface CounterProps {
  initial: number;
}

interface CounterState {
  count: number;
}

export class Counter extends React.Component<CounterProps, CounterState> {
  state = { count: 0 };

  /** Increment the counter */
  handleIncrement = () => {
    this.setState(prev => ({ count: prev.count + 1 }));
  };

  handleDecrement = () => {
    this.setState(prev => ({ count: prev.count - 1 }));
  };

  public validate = (value: number): boolean => {
    return value >= 0;
  };

  render() {
    return (
      <div>
        <span>{this.state.count}</span>
        <button onClick={this.handleIncrement}>+</button>
        <button onClick={this.handleDecrement}>-</button>
      </div>
    );
  }
}
