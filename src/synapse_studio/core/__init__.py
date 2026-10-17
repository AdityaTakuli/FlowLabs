"""The Synapse engine core.

Pure Python on top of pandas and scikit-learn (PyTorch when installed). The same code runs in the
desktop engine, in ``synapse engine`` on any machine, and inside the browser through Pyodide, so it
never starts threads or processes itself and never imports the server.
"""
