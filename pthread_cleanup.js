// Public lifecycle hook for pthread-enabled modularized Emscripten builds.
Module.terminatePthreadPool = function () {
  if (typeof PThread !== 'undefined' && PThread.terminateAllThreads) {
    PThread.terminateAllThreads();
    return true;
  }
  return false;
};
