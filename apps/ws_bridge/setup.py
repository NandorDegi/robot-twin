from setuptools import setup

package_name = "ws_bridge"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/launch", ["launch/stack.launch.py"]),
        ("share/" + package_name + "/config", ["config/bridge.yaml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="RDE robot-twin",
    maintainer_email="dev@rde.local",
    description="WebSocket bridge between the robot-twin UI and MoveIt / ros2_control for the Franka Panda.",
    license="Apache-2.0",
    tests_require=["pytest"],
    entry_points={
        "console_scripts": [
            "ws_bridge = ws_bridge.node:main",
        ],
    },
)
