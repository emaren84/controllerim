
import { proxify } from './proxify';
import { isPlainObject, cloneDeep, uniqueId, merge } from 'lodash';
import { registerControllerForTest, isTestMod, getMockedParent } from '../TestUtils/testUtils';
import { transaction, computed } from 'mobx';
const MethodType = Object.freeze({
  GETTER: 'GETTER',
  SETTER: 'SETTER'
});

const CONTROLLER_NODE_PROP = '_controllerNode';

export class Controller {
  static getParentController(componentInstance, parentControllerName) {
    //workaround to silent react getChildContext not defined warning:
    if(!componentInstance.getChildContext){
      componentInstance.getChildContext = () => {return { controllers: [], stateTree: [], childCount: {} };};
    }
    const controllerName = getAnonymousControllerName(componentInstance);
    return staticGetParentController(controllerName, componentInstance, parentControllerName);
  }

  constructor(componentInstance) {
    if (!componentInstance) {
      throw new Error(`Component instance is undefined. Make sure that you call 'new Controller(this)' inside componentWillMount and that you are calling 'super(componentInstance)' inside your controller constructor`);
    }
    if (isTestMod()) {
      registerControllerForTest(this, componentInstance);
    }

    const privateScope = {
      gettersAndSetters: {},
      isIndexingChildren: false,
      controllerId: uniqueId(),
      controllerName: this.constructor.name === 'Controller' ? getAnonymousControllerName(componentInstance) : this.constructor.name,
      stateTreeListeners: undefined,
      stateTree: undefined,
      internalState: { methodUsingState: undefined, previousState: undefined, initialState: undefined },
      component: componentInstance
    };

    initStateTree(this, privateScope);
    exposeControllerNodeOnComponent(this, privateScope);
    addGetChildContext(privateScope);
    exposeStateOnScope(this, privateScope);
    exposeGetParentControllerOnScope(this, privateScope);
    exposeMockStateOnScope(this, privateScope);
    exposeClearStateOnScope(this, privateScope);
    exposeGetStateTreeOnScope(this, privateScope);
    exposeSetStateTreeOnScope(this, privateScope);
    exposeAddStateTreeListener(this, privateScope);
    swizzleOwnMethods(this, privateScope);
    swizzleComponentWillUnmount(this, privateScope);
    swizzleComponentDidMount(this, privateScope);
    swizzleComponentDidUpdate(this, privateScope);
  }
}
const addGetChildContext = (privateScope) => {
  const componentInstance = privateScope.component;
  componentInstance.getChildContext = function () {
    let controllers = [];
    if (componentInstance.context.controllers) {//todo: remove after all the test will use mount
      controllers = [...this.context.controllers];
    }
    const controllerNode = componentInstance[CONTROLLER_NODE_PROP];
    const parentControllerNode = controllers[controllers.length - 1];
    if (parentControllerNode) {
      parentControllerNode.listenersLinkedList.children.push(controllerNode.listenersLinkedList);
    }
    controllers.push(controllerNode);
    privateScope.isIndexingChildren = true; //when react is calling getChildContext, we know we can start indexing the children
    return { controllers, stateTree: privateScope.stateTree.children, childCount: { value: 0, isIndexingChildren: privateScope.isIndexingChildren } };
  };
};
// const stateGuard = (internalState) => {
//   if (isStateLocked(internalState) && internalState.initialState !== undefined) {
//     throw new Error('Cannot set state from outside of a controller');
//   }
// };

const initStateTree = (publicScope, privateScope) => {
  const newstateTreeNode = {
    index: undefined,
    name: privateScope.controllerName,
    state: {},
    children: []
  };
  privateScope.stateTree = newstateTreeNode;
  if (privateScope.component.context.stateTree) {
    privateScope.component.context.stateTree.push(newstateTreeNode);
  }

};

const exposeControllerNodeOnComponent = (publicScope, privateScope) => {
  const controllerNode = {
    listenersLinkedList: {
      listeners: [],
      children: []
    },
    instance: publicScope,
    name: privateScope.controllerName,
  };

  privateScope.stateTreeListeners = controllerNode.listenersLinkedList;
  privateScope.component[CONTROLLER_NODE_PROP] = controllerNode;
};

const exposeStateOnScope = (publicScope, privateScope) => {
  const internalState = privateScope.internalState;
  Object.defineProperty(publicScope, 'state', {
    set: function (value) {
      if (!isPlainObject(value)) {
        throw new Error('State should be initialize only with plain object');
      }
      // stateGuard(internalState);
      privateScope.stateTree.state = global.Proxy ? proxify(value, privateScope) : value;
      if (internalState.initialState === undefined) {
        internalState.initialState = cloneDeep(value);
        internalState.previousState = JSON.stringify(internalState.initialState);
      }
    },
    get: function () {
      return privateScope.stateTree.state;
    }
  });
};

const swizzleOwnMethods = (publicScope, privateScope) => {
  const ownMethodNames = getOwnMethodNames(publicScope);
  ownMethodNames.forEach((name) => publicScope[name] = publicScope[name].bind(publicScope));

  const injectedFunction = global.Proxy ? undefined : getInjectedFunctionForNonProxyMode(privateScope);
  ownMethodNames.forEach((name) => {
    const regularBoundMethod = publicScope[name];
    let computedBoundMethod = computed(publicScope[name]);
    let siwzzledMethod;

    const computedIfPossible = (...args) => {
      if (args.length > 0) {
        //todo: derivation is not memoize, we still need to find a way to memoize it.
        return computedBoundMethod.derivation(...args);
      } else {
        return computedBoundMethod.get();
      }
    };

    const probMethodForGetterOrSetter = (...args) => {
      const result = regularBoundMethod(...args);
      if (result !== undefined) {
        markGetterOnPrivateScope(privateScope);
      }
      const methodType = privateScope.gettersAndSetters[name];
      if (methodType === MethodType.GETTER) {
        siwzzledMethod = computedIfPossible;
      } else if (methodType === MethodType.SETTER) {
        siwzzledMethod = regularBoundMethod;
      }
      return result;
    };

    siwzzledMethod = global.Proxy ? probMethodForGetterOrSetter : regularBoundMethod;
    publicScope[name] = (...args) => {
      unlockState(privateScope, name);
      let returnValue;
      transaction(() => {
        returnValue = siwzzledMethod(...args);
      });
      if (injectedFunction) {
        injectedFunction(name);
      }
      lockState(privateScope);
      return returnValue;
    };
  });
};

const getOwnMethodNames = (that) => {
  const controllerProto = Reflect.getPrototypeOf(that);
  const methodNames = Reflect.ownKeys(controllerProto);
  return methodNames.filter((name) => name !== 'constructor');
};

const exposeMockStateOnScope = (publicScope, privateScope) => {
  Object.defineProperty(publicScope, 'mockState', {
    enumerable: false,
    get: () => {
      return (state) => {
        if (!isTestMod()) {
          throw new Error('mockState can be used only in test mode. if you are using it inside your tests, make sure that you are calling TestUtils.init()');
        }
        unlockState(privateScope, 'mockState');
        Object.assign(privateScope.stateTree.state, state);
        lockState(privateScope);
      };
    }
  });
};

const exposeGetParentControllerOnScope = (publicScope, privateScope) => {
  const memoizedParentControllers = {};
  publicScope.getParentController = (parentControllerName) => {
    if (memoizedParentControllers[parentControllerName]) {
      return memoizedParentControllers[parentControllerName];
    } else {
      const parentController = staticGetParentController(privateScope.controllerName, privateScope.component, parentControllerName);
      memoizedParentControllers[parentControllerName] = parentController;
      return parentController;
    }
  };
};

const staticGetParentController = (currentControllerName, component, parentControllerName) => {
  let parentController = component.context.controllers && getControllerFromContext(component.context, parentControllerName);
  if (!parentController && isTestMod()) {
    parentController = getMockedParent(currentControllerName);
  }
  if (!parentController) {
    throw new Error(`Parent controller does not exist. make sure that ${parentControllerName} is parent of ${currentControllerName} and that you wraped it with observer`);
  }
  return parentController;
};

const getInjectedFunctionForNonProxyMode = (privateScope) => {
  return (methodName) => {
    if (privateScope.gettersAndSetters[methodName] === MethodType.GETTER) {
      return;
    } else if (privateScope.gettersAndSetters[methodName] === MethodType.SETTER) {
      privateScope.stateTreeListeners.listeners.forEach(listener => listener(privateScope.stateTree));
      privateScope.component.forceUpdate();
    } else if (JSON.stringify(privateScope.stateTree.state) !== privateScope.internalState.previousState) {
      privateScope.stateTreeListeners.listeners.forEach(listener => listener(privateScope.stateTree));
      privateScope.internalState.previousState = JSON.stringify(privateScope.stateTree.state);
      privateScope.component.forceUpdate();
      // markSetterOnPrivateScope(privateScope,methodName); todo: fix marking of getter functions without state, can test with "should work with higher order components"
    }
  };
};

const exposeClearStateOnScope = (publicScope, privateScope) => {
  publicScope.clearState = () => {
    const value = cloneDeep(privateScope.internalState.initialState);
    transaction(() => {
      Object.keys(publicScope.state).forEach(key => {
        delete publicScope.state[key];
      });
      Object.assign(publicScope.state, value);
    });
    privateScope.component.forceUpdate();
  };
};

const exposeGetStateTreeOnScope = (publicScope, privateScope) => {
  publicScope.getStateTree = () => {
    return privateScope.stateTree;
  };
};

const exposeSetStateTreeOnScope = (publicScope, privateScope) => {
  publicScope.setStateTree = (stateTree) => {
    transaction(() => {
      merge(privateScope.stateTree, stateTree);
    });
    privateScope.component.forceUpdate();
  };
};

const exposeAddStateTreeListener = (publicScope, privateScope) => {
  const recursivePushListenersToChildren = (node, listener) => {
    node.listeners.push(listener);
    node.children.forEach(childNode => {
      recursivePushListenersToChildren(childNode, listener);
    });
  };

  const recursiveRemoveListenersFromChildren = (node, listener) => {
    node.listeners.splice(node.listeners.indexOf(listener), 1);
    node.children.forEach(childNode => {
      recursiveRemoveListenersFromChildren(childNode, listener);
    });
  };

  publicScope.addOnStateTreeChangeListener = (listener) => {
    const triggerListenerFunction = () => listener(privateScope.stateTree);
    privateScope.stateTreeListeners.listeners.push(listener);
    privateScope.stateTreeListeners.children.forEach(child => {
      recursivePushListenersToChildren(child, triggerListenerFunction);
    });
    return () => {
      privateScope.stateTreeListeners.listeners.splice(privateScope.stateTreeListeners.listeners.indexOf(listener), 1);
      privateScope.stateTreeListeners.children.forEach(child => {
        recursiveRemoveListenersFromChildren(child, triggerListenerFunction);
      });
    };
  };
};


const getControllerFromContext = (context, name) => {
  const foundObj = context.controllers.find(obj => obj.name === name);
  if (foundObj) {
    return foundObj.instance;
  }
};

const getAnonymousControllerName = (componentInstance) => {
  return 'AnonymousControllerFor' + componentInstance.constructor.name;
};

const unlockState = (privateScope, methodName) => {
  privateScope.internalState.methodUsingState = methodName;
};

const lockState = (privateScope) => {
  privateScope.internalState.methodUsingState = undefined;
};
export const isStateLocked = (internalState) => {
  return internalState.methodUsingState === undefined;
};

export const markSetterOnPrivateScope = (privateScope, methodName) => {
  privateScope.gettersAndSetters[methodName] = MethodType.SETTER;
};

const markGetterOnPrivateScope = (privateScope) => {
  privateScope.gettersAndSetters[privateScope.internalState.methodUsingState] = MethodType.GETTER;
};

const swizzleComponentWillUnmount = (publicScope, privateScope) => {
  let originalMethod = getBoundLifeCycleMethod(privateScope.component, 'componentWillUnmount');
  privateScope.component.componentWillUnmount = () => {
    //todo: consider completely removing the child from parent
    Object.keys(privateScope.stateTree).forEach(key => {
      delete privateScope.stateTree[key];
    });
    originalMethod();
  };
};

const swizzleComponentDidMount = (publicScope, privateScope) => {
  let originalMethod = getBoundLifeCycleMethod(privateScope.component, 'componentDidMount');
  privateScope.component.componentDidMount = () => {
    updateIndex(publicScope, privateScope);
    originalMethod();
  };
};

const swizzleComponentDidUpdate = (publicScope, privateScope) => {
  let originalMethod = getBoundLifeCycleMethod(privateScope.component, 'componentDidUpdate');
  privateScope.component.componentDidUpdate = () => {
    if (privateScope.component.context.childCount) {
      privateScope.component.context.childCount.isIndexingChildren = false;
    }
    updateIndex(publicScope, privateScope);
    originalMethod();
  };
};

const updateIndex = (publicScope, privateScope) => {
  if (privateScope.component.context.childCount) { //todo: remove after all test will use mount
    if (privateScope.component.context.childCount.isIndexingChildren) {
      const index = privateScope.component.context.childCount.value++;
      privateScope.stateTree.index = index;
    }
  }
};

const getBoundLifeCycleMethod = (component, methodName) => {
  if (component[methodName]) {
    return component[methodName].bind(component);
  } else {
    return () => { };
  }
};

